import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { currentConversationContext } from './conversation-context.js';
import { capturePaidAuthority, assertPaidAuthority, productionPaidCallGuard } from './paid-call-guard.js';
import { createOpenAiImageProvider, IMAGE_MODEL, normalizeImageRequest, estimateImageCost } from './image-generation-provider.js';
import { loadReferenceImage, selectTriggerEntry } from './qq-request-media.js';
import { createImageGenerationTiming } from './image-generation-timing.js';

const quotes = { png: 0.5, gif: 4, svg: 3 };
const maxJobs = 8;

export function createImageGenerationTool({
  generate, paidGuard = productionPaidCallGuard, captureAuthority = capturePaidAuthority,
  assertAuthority = assertPaidAuthority, log = console.warn, loadReference = loadReferenceImage,
  timing = createImageGenerationTiming(),
}) {
  const waiting = [];
  const busy = new Set();
  const usedContexts = new WeakSet();
  let running = false;

  async function notify(job, text, stage, check = job.guard) {
    const { ctx, id, replyToMessageId } = job;
    try {
      await ctx.sender.sendTextBatch(ctx.chatKey, [text], {
        guard: check, replyToMessageId, dedupeKey: `image:${id}:${stage}`,
      });
    } catch { log('image status delivery skipped', id, stage); }
  }

  async function generateAndDeliver(job) {
    const { ctx, request, id, guard, actor, referenceEntry, replyToMessageId, queuedAt } = job;
    const dequeuedAt = performance.now();
    const category = request.format === 'png' && referenceEntry ? 'reference' : request.format;
    let startedAt, generatedAt;
    let hold, ledger, result, failure, referenceImage, referenceFailed = false;
    try {
      guard();
      if (referenceEntry) {
        try { referenceImage = await loadReference(ctx, referenceEntry); }
        catch (error) { referenceFailed = true; throw error; }
        guard();
      }
      ledger = paidGuard();
      hold = ledger.prepareImage({ operationId: id, amountCny: quotes[request.format], model: IMAGE_MODEL });
      try {
        ledger.dispatch(hold);
      } catch (error) {
        ledger.release(hold);
        throw error;
      }
      const estimate = timing.estimate(category);
      startedAt = performance.now();
      void notify(job, estimate.seconds ? `开始画了，预计 ${estimate.seconds} 秒。` : '开始画了。', 'start');
      let finished = false;
      const reminder = setTimeout(() => {
        void notify(job, '这张画得比平时久一些，还在等结果。', 'slow', () => {
          guard();
          if (finished) throw Error('绘图已结束');
        });
      }, estimate.reminderMs);
      reminder.unref?.();
      try {
        result = await generate({ ...request, actor, signal: ctx.abortSignal, referenceImage });
      } catch (error) {
        failure = error;
      } finally {
        finished = true;
        generatedAt = performance.now();
        clearTimeout(reminder);
      }
      try {
        ledger.completeImage(hold, { amount: estimateImageCost(request.format, result?.usage ?? failure?.usage), refusal: failure?.refusal === true });
      } catch {
        log('image job settlement pending', id);
      }
    } catch {
      failure = Error('当前会话的额度或授权无法开始绘图。');
    }
    try {
      guard();
      if (!result) {
        log('image job failed before delivery', id, request.format, failure?.status ?? '-', failure?.providerCode ?? '-');
        let message = '这次绘图没完成，可以稍后再试。';
        if (referenceFailed) message = '没能取得一张可用的参考图，请重新发一张 PNG、JPG 或 WebP 图片。';
        else if (!hold) message = '当前会话的额度或授权无法开始绘图。';
        else if (failure?.providerCode === 'insufficient_quota') message = '绘图账户的 API 额度不足。';
        else if (failure?.status === 429) message = '绘图服务正在限流，过一会儿再试。';
        else if (['content_policy_violation', 'moderation_blocked', 'safety_violations'].includes(failure?.providerCode)) message = '绘图服务拦截了这次描述，可以换个画面再试。';
        else if (failure?.status) message = `绘图服务拒绝了这次请求（HTTP ${failure.status}）。`;
        await notify(job, message, 'failed');
      } else if (result.format === 'svg') {
        const name = '绘图-' + id.slice(0, 8) + '.svg';
        await ctx.sender.sendGeneratedFile(ctx.chatKey, result.bytes, name, { guard });
        await notify(job, `画好了，SVG 文件「${name}」已发到这里。`, 'svg');
      } else {
        const segments = [{ type: 'image', data: { file: 'base64://' + result.bytes.toString('base64') } }];
        if (replyToMessageId) segments.unshift({ type: 'reply', data: { id: replyToMessageId } });
        await ctx.sender.sendMedia(ctx.chatKey, segments, {
          guard, dedupeKey: id, label: result.format === 'gif' ? '[绘图 GIF]' : '[绘图 PNG]'
        });
      }
      if (result) timing.record(category, {
        queueMs: dequeuedAt - queuedAt,
        generationMs: generatedAt - startedAt,
        deliveryMs: performance.now() - generatedAt,
      });
    } catch {
      log('image job delivery unconfirmed', id, request.format);
      if (result) await notify(job, '图已生成，QQ 回传没有确认成功。', 'delivery-failed');
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (waiting.length) {
        const job = waiting.shift();
        try { await job.run(generateAndDeliver, job); }
        finally { busy.delete(job.ctx.chatKey); }
      }
    } finally {
      running = false;
    }
  }

  return {
    id: 'generate_image', name: '绘图', category: 'messaging', icon: '🎨',
    description: '用户明确要求画图时调用。改原图、按参考图画新图或让静态图动起来时，传 reference=true，使用请求消息的附图或明确引用的图。静态改图用 format=png，让原图动起来用 format=gif，并在描述里写清动作。纯文字生成支持 PNG、GIF、SVG。后台会自动发排队通知（如需等待）、开工通知和成图，无需另发确认。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '用户要画的内容和画风' },
        reference: { type: 'boolean', description: '用原图改图或做 GIF 时传 true，读取真实图片。取图失败时请用户重发。' },
        requestMessageId: { type: 'string', description: '发出这次绘图请求的未读消息 #数字（不带 #）。同批有多条消息时必填。不要填被引用的图片消息编号。' },
        format: { type: 'string', enum: ['png', 'gif', 'svg'], description: '默认 png。动图用 gif，矢量图用 svg' },
        size: { type: 'string', description: '可选。普通图和 SVG 用 1024x1024、1536x1024 或 1024x1536，GIF 默认 512x512' },
        frames: { type: 'integer', minimum: 2, maximum: 16, description: '可选，仅 GIF，默认 9 帧' },
        frameMs: { type: 'integer', minimum: 20, maximum: 2000, description: '可选，仅 GIF，每帧毫秒数，默认 200' }
      }
    },
    execute(ctx, args) {
      const context = currentConversationContext();
      const denied = content => ({ content, isError: true });
      if (ctx.proactive || !ctx.triggerEntries?.length || context?.botId !== 'primary' || context.conversationKey !== ctx.chatKey) {
        return denied('绘图需要当前 QQ 会话的用户请求。');
      }
      if (usedContexts.has(context) || busy.has(ctx.chatKey)) return denied('这个会话已有一张图在处理。');
      if (busy.size >= maxJobs) return denied('绘图队列已满，稍后再试。');
      let request, authority;
      try {
        request = normalizeImageRequest(args);
      } catch (error) {
        return denied(error.message);
      }
      const requestEntry = selectTriggerEntry(ctx.triggerEntries, args.requestMessageId);
      const replyToMessageId = /^-?[1-9]\d*$/.test(String(requestEntry?.mid)) ? String(requestEntry.mid) : null;
      if ((args.requestMessageId != null || ctx.triggerEntries.length > 1) && !replyToMessageId) {
        return denied('请填写发出绘图请求的未读消息编号，画完后会回复那条消息。');
      }
      const referenceEntry = args?.reference === true ? requestEntry : null;
      if (args?.reference === true && request.format === 'svg') return denied('参考图可以输出 PNG 或 GIF。SVG 当前支持从文字生成。');
      if (args?.reference === true && !referenceEntry) return denied('请用这批未读消息里的绘图请求编号定位参考图。');
      if (referenceEntry && !referenceEntry.reply?.mid && !referenceEntry.media?.some(item => item.kind === 'image')) {
        return denied('请发一张图，或引用那张图再说要怎么改。');
      }
      try {
        ctx.assertCurrent();
        authority = captureAuthority(ctx.chatKey);
      } catch {
        return denied('当前会话未获绘图授权。');
      }
      const guard = () => {
        ctx.assertCurrent();
        assertAuthority(ctx.chatKey, authority);
      };
      const actor = String(requestEntry?.senderId ?? ctx.triggerEntries.find(entry => entry.senderId)?.senderId ?? ctx.chatKey);
      const id = randomUUID();
      const ahead = busy.size;
      const job = { ctx, id, request, actor, guard, referenceEntry, replyToMessageId, queuedAt: performance.now(), run: AsyncLocalStorage.snapshot() };
      usedContexts.add(context);
      busy.add(ctx.chatKey);
      waiting.push(job);
      if (ahead > 0) {
        void notify(job, `接到了，前面还有 ${ahead} 张，轮到就开画。`, 'queued', () => {
          guard();
          if (!waiting.includes(job)) throw Error('绘图已开始处理');
        });
      }
      setImmediate(() => drain().catch(() => log('image queue interrupted')));
      return { content: '后台已接单，通知和成图会自动发回，无需另发确认。' };
    }
  };
}

export function configuredImageGenerationTool() {
  if (!process.env.CREDENTIALS_DIRECTORY || process.env.QQ_AGENT_HOSTED_BOT_ID) return null;
  let apiKey;
  try { apiKey = readFileSync(join(process.env.CREDENTIALS_DIRECTORY, 'openai-image-key'), 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return apiKey ? createImageGenerationTool({
    generate: createOpenAiImageProvider({ apiKey }),
    timing: createImageGenerationTiming({ file: join(DATA_DIR, 'image-generation-timing.json') }),
  }) : null;
}
