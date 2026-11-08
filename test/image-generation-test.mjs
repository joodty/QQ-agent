import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runWithConversationContext, currentConversationContext } from '../src/conversation-context.js';
import { createOpenAiImageProvider, normalizeImageRequest } from '../src/image-generation-provider.js';
import { createImageGenerationTool } from '../src/image-generation-tool.js';
import { SendQueue } from '../src/sender.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const gif = Buffer.from('4749463839610002000287ff00', 'hex');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');
const actor = 'test-actor';

test('provider sends native format options and rejects bytes with a different format', async () => {
  const requests = [];
  const generate = createOpenAiImageProvider({
    apiKey: 'fake', sanitize: async bytes => bytes,
    fetchImpl: async (_url, { body }) => {
      const request = JSON.parse(body);
      requests.push(request);
      const bytes = { png, gif, svg }[request.output_format];
      return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
    }
  });
  for (const [format, bytes] of Object.entries({ png, gif, svg })) {
    const output = await generate({ ...normalizeImageRequest({ prompt: 'a circle', format, frames: 4, frameMs: 90 }), actor });
    assert.deepEqual(output.bytes, bytes);
  }
  assert.equal(requests[1].frame_count, 4);
  assert.equal(requests[1].frame_duration_ms, 90);
  assert.equal(requests[2].svg.model, 'gpt-5.4-mini');
  assert.notEqual(requests[0].safety_identifier, actor);
  assert.throws(() => normalizeImageRequest({ prompt: 'a circle', format: 'gif', frames: 17 }));
  const mismatch = createOpenAiImageProvider({ apiKey: 'fake', fetchImpl: async () => Response.json({ data: [{ b64_json: png.toString('base64') }] }) });
  await assert.rejects(mismatch({ ...normalizeImageRequest({ prompt: 'a circle', format: 'gif' }), actor }), /格式不符/);
  const refused = createOpenAiImageProvider({
    apiKey: 'fake',
    fetchImpl: async () => Response.json({ error: { code: 'insufficient_quota', message: 'private details' } }, { status: 429 })
  });
  await assert.rejects(refused({ ...normalizeImageRequest({ prompt: 'a circle' }), actor }), {
    status: 429, providerCode: 'insufficient_quota', refusal: true, message: '图像服务拒绝了请求（HTTP 429）'
  });
});

function submit(tool, ctx, format, options = {}) {
  return runWithConversationContext({
    botId: 'primary', conversationKey: ctx.chatKey, actorId: actor,
    fundingRef: { id: 'platform', version: 1 }, personaRef: { id: 'primary', version: 1 }
  }, () => tool.execute(ctx, { prompt: 'a circle', format, ...options }));
}

test('a quoted reference can become a GIF with user-selected playback options', async () => {
  const events = new EventEmitter();
  const referenceImage = 'data:image/png;base64,' + png.toString('base64');
  const ctx = {
    chatKey: 'group:101', assertCurrent() {}, triggerEntries: [{ mid: '1', senderId: '7', reply: { mid: '-2' } }],
    sender: {
      async sendMedia(chatKey, segments) { events.emit('delivery', { chatKey, segments }); },
      async sendTextBatch(_chatKey, messages) { events.emit('delivery', { messages }); }
    }
  };
  const generate = createOpenAiImageProvider({ apiKey: 'fake', async fetchImpl(endpoint, { body }) {
    assert.equal(endpoint, 'https://api.openai.com/v1/images/edits');
    const request = JSON.parse(body);
    assert.deepEqual(request.images, [{ image_url: referenceImage }]);
    assert.equal(request.output_format, 'gif');
    assert.equal(request.frame_count, 4);
    assert.equal(request.frame_duration_ms, 180);
    return Response.json({ data: [{ b64_json: gif.toString('base64') }] });
  } });
  const tool = createImageGenerationTool({
    generate, captureAuthority: () => ({}), assertAuthority() {},
    async loadReference(_ctx, entry) {
      assert.equal(entry.reply.mid, '-2');
      return referenceImage;
    },
    paidGuard: () => ({ prepareImage: args => args, dispatch() {}, completeImage() {} }),
  });
  assert.equal(submit(tool, ctx, 'svg', { reference: true }).isError, true);
  const delivery = once(events, 'delivery', { signal: AbortSignal.timeout(3000) });
  assert.match(submit(tool, ctx, 'gif', { reference: true, frames: 4, frameMs: 180 }).content, /已排队/);
  assert.deepEqual(await delivery, [{
    chatKey: 'group:101', segments: [{ type: 'image', data: { file: 'base64://' + gif.toString('base64') } }]
  }]);
});

test('acknowledges immediately, deduplicates, and delivers through the original chat with isolated funding context', async () => {
  const events = new EventEmitter();
  const settlements = [];
  const delivered = [];
  const funding = [];
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const sender = new SendQueue({
    onebot: {
      async sendSegments(kind, id, segments) {
        delivered.push([kind, id, segments[0].data.file]);
        events.emit('delivery');
        return { message_id: 1 };
      },
      async call(action, params) {
        delivered.push([action, params.user_id, params.file]);
        events.emit('delivery');
        return { file_id: 'file' };
      }
    },
    store: { appendSelf() {} },
  });
  const tool = createImageGenerationTool({
    captureAuthority: () => ({}), assertAuthority() {}, log() {},
    paidGuard: () => ({
      prepareImage: args => { funding.push(currentConversationContext().conversationKey); return args; },
      dispatch() {},
      completeImage: (_hold, details) => settlements.push(details)
    }),
    async generate({ format }) { await gate; return { format, bytes: format === 'gif' ? gif : svg }; }
  });
  const group = { chatKey: 'group:101', triggerEntries: [{ senderId: '7' }], sender, assertCurrent() {} };
  const privateChat = { ...group, chatKey: 'private:202' };
  assert.match(submit(tool, group, 'gif').content, /已排队/);
  assert.equal(submit(tool, group, 'png').isError, true);
  assert.match(submit(tool, privateChat, 'svg').content, /已排队/);
  assert.equal(delivered.length, 0);
  const first = once(events, 'delivery', { signal: AbortSignal.timeout(5000) });
  unblock();
  await first;
  await once(events, 'delivery', { signal: AbortSignal.timeout(5000) });
  await sender.whenIdle();
  assert.deepEqual(funding, ['group:101', 'private:202']);
  assert.deepEqual(delivered, [['group', '101', 'base64://' + gif.toString('base64')], ['upload_private_file', 202, 'base64://' + svg.toString('base64')]]);
  assert.equal(settlements.length, 2);
  assert.equal(submit(tool, { ...group, proactive: true }, 'png').isError, true);
});

test('revoked access suppresses both the provider request and QQ delivery', async () => {
  let revoked = false, calls = 0;
  const tool = createImageGenerationTool({
    captureAuthority: () => ({}), assertAuthority() { if (revoked) throw Error('revoked'); }, log() {},
    paidGuard() { calls++; },
  });
  const ctx = { chatKey: 'group:101', triggerEntries: [{}], assertCurrent() {}, sender: { sendTextBatch() { calls++; } } };
  assert.match(submit(tool, ctx, 'png').content, /已排队/);
  revoked = true;
  await delay(10);
  assert.equal(calls, 0);
});
