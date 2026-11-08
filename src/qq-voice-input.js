const listenRequest = /听|转写|转[成为]?文字|语音.{0,8}(说|内容)|transcrib|what did .{0,24} say/i;

export function selectVoiceInput({ kind, segments, selfId }) {
  const addressed = kind === 'private' || !!selfId && segments.some(s => s.type === 'at' && String(s.data?.qq) === String(selfId));
  if (!addressed) return null;
  if (segments.some(s => s.type === 'record')) return 'direct';
  const text = segments.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join(' ');
  return segments.some(s => s.type === 'reply') && listenRequest.test(text) ? 'quote' : null;
}

export function quotedVoiceInChat(message, kind, id, selfId) {
  if (!Array.isArray(message?.message) || !message.message.some(s => s.type === 'record')) return false;
  if (kind === 'group') return String(message.group_id ?? '') === String(id);
  const sender = String(message.sender?.user_id ?? message.user_id ?? '');
  return message.message_type === 'private' && (sender === String(id) ||
    !!selfId && sender === String(selfId) && String(message.target_id ?? '') === String(id));
}

export async function transcribeQqVoice(onebot, mid) {
  const messageId = Number(mid);
  const fallback = '[语音未识别]';
  if (!Number.isSafeInteger(messageId) || !messageId) return fallback;
  try {
    const result = await onebot.call('fetch_ptt_text', { message_id: messageId }, 8000);
    const text = typeof result?.text === 'string' ? result.text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 800) : '';
    return text ? '[语音转文字] ' + text : fallback;
  } catch {
    return fallback;
  }
}
