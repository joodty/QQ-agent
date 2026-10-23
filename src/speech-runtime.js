// Tencent speech shares the Agent context and the existing outbound queue.
import { capturePaidAuthority } from './paid-call-guard.js';
export function speechErrorMessage(code) {
  if (/CREDENTIAL|NO_CREDENTIAL/.test(code || '')) return '腾讯云语音凭据尚未配置好，请联系平台管理员。';
  if (/SUBSIDY/.test(code || '')) return '管理员尚未为这个聊天开通平台语音额度。';
  if (/PLATFORM_DISABLED/.test(code || '')) return '平台语音回复尚未开启。';
  if (/CHAT_DISABLED/.test(code || '')) return '这个聊天的语音回复已关闭。';
  if (/VERSION|CHANGED|STALE/.test(code || '')) return '设置已经变化，请刷新后再操作。';
  if (/ACCESS|UNAUTH|PERMISSION/.test(code || '')) return '你没有权限管理这个聊天的语音设置。';
  if (/SETTINGS|TEXT_TOO_LONG|TEXT_INVALID|SCOPE_INVALID/.test(code || '')) return '设置不符合平台限制，请检查字数、冷却时间和额度。';
  if (/BUDGET|ADMISSION/.test(code || '')) return '语音额度暂不可用，请使用文字回复。';
  if (/COOLDOWN|BUSY/.test(code || '')) return '语音回复还在冷却或处理中，请稍后再试。';
  return '语音操作未完成，请稍后再试；聊天仍可使用文字回复。';
}

export function speechWasRequested(entries, { proactive = false } = {}) {
  if (proactive || !Array.isArray(entries)) return false;
  const human = entries.filter(item => !item.self).map(item => String(item.text || '')).join('\n');
  if (/(?:不要|不用|别|无需|禁止).{0,4}(?:语音|朗读|读出来)/u.test(human)) return false;
  return /(?:用|发|来|给|回).{0,10}语音|语音.{0,8}(?:说|回复|回答|念)|(?:念|读)(?:一下|一遍|给我听|出来)|朗读/u.test(human);
}
function current(ctx) {
  if (ctx.abortSignal?.aborted) throw Object.assign(Error('本次回复已取消'), { code: 'SPEECH_CANCELLED' });
  ctx.assertCurrent?.();
  ctx.store?.assertArchiveCurrent?.(ctx.chatKey, ctx.session?.archiveSelection);
  capturePaidAuthority(ctx.chatKey);
}
function note(ctx, type, text) {
  try {
    ctx.session?.sent?.push({ type, text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
    ctx.emit?.('session-update', { sessionId: ctx.session?.id });
  } catch { /* The QQ result remains authoritative if a UI listener fails. */ }
}
function replyState(ctx) { return ctx.speechReplyState ||= { decided: false, selected: false, attempted: false, deliveryUnknown: false, spokenText: null }; }
function declined(ctx) { return (ctx.triggerEntries || []).some(entry => !entry.self && /(?:不要|不用|别|无需|禁止).{0,4}(?:语音|朗读|读出来)/u.test(String(entry.text || ''))); }
function eligible(text, policy) {
  return text.length > 0 && text.length <= policy.settings.maxChars && /[\p{L}\p{N}]/u.test(text)
    && !/https?:\/\/|www\.|```|[<>]|\[CQ:/i.test(text);
}
async function deliverSpeech(ctx, text, { automatic = false } = {}) {
  const state = replyState(ctx), service = ctx.speech;
  if (state.deliveryUnknown) throw Object.assign(Error('上一条语音交付未确认，本轮不自动重复发送。'), { code: 'SPEECH_DELIVERY_UNKNOWN' });
  if (state.spokenText === text) return { sent: [], failed: [], duplicate: true };
  state.decided = true; state.attempted = true;
  let sending = false;
  try {
    current(ctx);
    const policy = service.runtimePolicy(ctx.chatKey);
    if (!policy.allowed) throw Object.assign(Error(speechErrorMessage(policy.reason)), { code: policy.reason || 'SPEECH_DISABLED' });
    const built = await service.synthesize(ctx.chatKey, {
      text, operationId: `${ctx.session?.id || 'chat'}:${ctx.toolCallId || 'speech'}`,
      signal: ctx.abortSignal, direct: !automatic,
      ...(automatic ? { purpose: 'automatic', automaticSelected: true } : {})
    });
    const guard = () => { current(ctx); service.assertCurrent(built.receipt); };
    guard();
    if (!Buffer.isBuffer(built.audio) || !built.audio.length) throw Object.assign(Error('语音内容无效'), { code: 'SPEECH_AUDIO_INVALID' });
    sending = true;
    const result = await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: `base64://${built.audio.toString('base64')}` } }], {
      label: `[语音] ${built.transcript || text}`, dedupeKey: `speech:${ctx.session?.id || 'chat'}:${ctx.toolCallId || text}`, guard
    });
    state.spokenText = built.transcript || text;
    return { sent: [{ text: state.spokenText, kind: 'voice', messageId: result?.message_id ?? null, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }], failed: [] };
  } catch (error) {
    if (sending) {
      state.deliveryUnknown = true;
      throw Object.assign(Error('本次语音发送未能确认，请勿自动重复发送。'), { code: 'SPEECH_DELIVERY_UNKNOWN' });
    }
    current(ctx);
    const policy = service.runtimePolicy(ctx.chatKey);
    if (/CHANGED|REVOK|DISABL|CANCEL|ABORT|UNAUTH|PERMISSION|ACCESS_DENIED|STALE/.test(String(error.code || '')) || !policy.allowed) throw error;
    const guard = () => {
      current(ctx); const latest = service.runtimePolicy(ctx.chatKey);
      if (!latest.allowed || latest.policyVersion !== policy.policyVersion) throw Object.assign(Error('语音设置已变化'), { code: 'SPEECH_AUTHORIZATION_CHANGED' });
    };
    guard();
    return ctx.sender.sendTextBatch(ctx.chatKey, [text], { guard });
  }
}

/** Installed only in an ordinary Agent run. Direct application notifications,
 * binding confirmations and reminders continue using the original SendQueue. */
export function createSpeechReplySender(ctx, { random = Math.random } = {}) {
  if (typeof random !== 'function') throw TypeError('speech random must be a function');
  return async (messages, options = {}) => {
    const text = (Array.isArray(messages) ? messages : [messages]).map(value => String(value ?? '').trim()).filter(Boolean).join('\n');
    const state = replyState(ctx);
    if (state.deliveryUnknown) throw Object.assign(Error('语音交付未确认，本轮不自动重复发送。'), { code: 'SPEECH_DELIVERY_UNKNOWN' });
    if (state.spokenText === text) return { sent: [], failed: [], duplicate: true };
    const plain = () => ctx.sender.sendTextBatch(ctx.chatKey, messages, { ...options, guard() { current(ctx); return options.guard?.(); } });
    if (!ctx.speech || ctx.proactive || declined(ctx) || options.replyToMessageId || options.atUserId) return plain();
    current(ctx);
    let policy;
    try {
      policy = ctx.speech.runtimePolicy(ctx.chatKey);
      if (!eligible(text, policy)) return plain();
    } catch {
      // Optional speech must not make an otherwise authorized text reply fail.
      // Consume the automatic decision; a later tool call cannot keep retrying it.
      state.decided = true;
      return plain();
    }
    const requested = speechWasRequested(ctx.triggerEntries);
    if (!requested && (state.decided || state.attempted)) return plain();
    if (!requested) {
      state.decided = true;
      const percent = policy.settings.autoVoicePercent || 0;
      const roll = random();
      state.selected = Number.isFinite(roll) && roll >= 0 && roll < 1 && roll < percent / 100;
      if (!state.selected) return plain();
    }
    // A selected reply consumes this run's single decision even if dependency,
    // cooldown or budget admission denies speech. No repeated coin tossing.
    if (!policy.allowed) return plain();
    return deliverSpeech(ctx, text, { automatic: !requested });
  };
}
export const speechToolDefinition = {
  id: 'send_voice', name: '用语音回复', category: 'messaging', icon: '🔊', defaultEnabled: true,
  description: '仅在当前聊天的人明确要求语音、朗读或念出来时，把一句简短回复合成为腾讯云语音发到当前聊天。是否可用由该聊天的开关、平台语音资助及额度决定。成功或已回退文字后不要重复发送同一句；不要用于主动发言。',
  parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: '要朗读的一句简短回复，纯文字，不含链接、Markdown或动作描写。' } }, required: ['text'] },
  async execute(ctx, args) {
    if (!ctx.speech || !ctx.sender || !ctx.chatKey) return { content: '腾讯云语音尚未准备好，请使用文字回复。', isError: true };
    if (!speechWasRequested(ctx.triggerEntries, { proactive: ctx.proactive })) return { content: '这次没有明确索要语音，请使用文字回复。', isError: true };
    const text = typeof args?.text === 'string' ? args.text.trim() : '';
    const policy = ctx.speech.runtimePolicy(ctx.chatKey);
    if (!policy.allowed) return { content: speechErrorMessage(policy.reason), isError: true };
    if (!eligible(text, policy)) return { content: `请使用不含链接或代码、${policy.settings.maxChars} 字以内的简短文字。`, isError: true };
    try {
      const result = await deliverSpeech(ctx, text);
      for (const sent of result.sent) note(ctx, sent.kind || 'text', sent.text);
      return { content: result.sent.some(item => item.kind === 'voice') ? '这句语音已经发出，请勿重复发送文字或再次合成。' : '已用文字发出原句，或该句之前已经发出，请勿重复发送。' };
    } catch (error) {
      return { content: error.code === 'SPEECH_DELIVERY_UNKNOWN' ? error.message : '本次回复状态或授权已变化，未自动重发。', isError: true };
    }
  }
};
