import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentConversationContext } from './conversation-context.js';
import { capturePaidAuthority, assertPaidAuthority, productionPaidCallGuard } from './paid-call-guard.js';
import { createOpenAiImageProvider, IMAGE_MODEL, normalizeImageRequest, estimateImageCost } from './image-generation-provider.js';

const quotes = { png: 0.5, gif: 4, svg: 3 };
const maxJobs = 8;

export function createImageGenerationTool({
  generate, paidGuard = productionPaidCallGuard, captureAuthority = capturePaidAuthority,
  assertAuthority = assertPaidAuthority, log = console.warn,
}) {
  const waiting = [];
  const busy = new Set();
  const usedContexts = new WeakSet();
  let running = false;

  async function generateAndDeliver(job) {
    const { ctx, request, id, guard, actor } = job;
    let hold, ledger, result, failure;
    try {
      guard();
      ledger = paidGuard();
      hold = ledger.prepareImage({ operationId: id, amountCny: quotes[request.format], model: IMAGE_MODEL });
      try {
        ledger.dispatch(hold);
      } catch (error) {
        ledger.release(hold);
        throw error;
      }
      try {
        result = await generate({ ...request, actor, signal: ctx.abortSignal });
      } catch (error) {
        failure = error;
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
        log('image job failed before delivery', id, request.format);
        await ctx.sender.sendTextBatch(ctx.chatKey, [hold ? '这次绘图没完成，可以稍后再试。' : '当前会话的额度或授权无法开始绘图。'], { guard });
      } else if (result.format === 'svg') {
        await ctx.sender.sendGeneratedFile(ctx.chatKey, result.bytes, '绘图-' + id.slice(0, 8) + '.svg', { guard });
      } else {
        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'image', data: { file: 'base64://' + result.bytes.toString('base64') } }], {
          guard, dedupeKey: id, label: result.format === 'gif' ? '[绘图 GIF]' : '[绘图 PNG]'
        });
      }
    } catch {
      log('image job delivery unconfirmed', id, request.format);
      if (result) await Promise.resolve().then(() => ctx.sender.sendTextBatch(ctx.chatKey, ['图已生成，QQ 回传没有确认成功。'], { guard })).catch(() => {});
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
    description: '用户明确要求画图时调用。后台生成 PNG 普通图、GIF 动图或 SVG 矢量文件，完成后自动发回当前 QQ 会话。提交成功后只需简短告知已排队，可继续聊天。一次请求调用一次。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '用户要画的内容和画风' },
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
      const actor = String(ctx.triggerEntries.find(entry => entry.senderId)?.senderId ?? ctx.chatKey);
      const id = randomUUID();
      usedContexts.add(context);
      busy.add(ctx.chatKey);
      waiting.push({ ctx, id, request, actor, guard, run: AsyncLocalStorage.snapshot() });
      setImmediate(() => drain().catch(() => log('image queue interrupted')));
      return { content: '绘图已排队，完成后会发回这里。' };
    }
  };
}

export function configuredImageGenerationTool() {
  if (!process.env.CREDENTIALS_DIRECTORY || process.env.QQ_AGENT_HOSTED_BOT_ID) return null;
  let apiKey;
  try { apiKey = readFileSync(join(process.env.CREDENTIALS_DIRECTORY, 'openai-image-key'), 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return apiKey ? createImageGenerationTool({ generate: createOpenAiImageProvider({ apiKey }) }) : null;
}
