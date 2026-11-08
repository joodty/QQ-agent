import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithConversationContext, currentConversationContext } from '../src/conversation-context.js';
import { createOpenAiImageProvider, normalizeImageRequest } from '../src/image-generation-provider.js';
import { createImageGenerationTool } from '../src/image-generation-tool.js';
import { createImageGenerationTiming } from '../src/image-generation-timing.js';
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
      async sendMedia(chatKey, segments) {
        events.emit('delivery', { chatKey, segments });
        return { message_id: 7 };
      },
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
  assert.match(submit(tool, ctx, 'gif', { reference: true, frames: 4, frameMs: 180 }).content, /已接单/);
  assert.deepEqual(await delivery, [{
    chatKey: 'group:101', segments: [
      { type: 'reply', data: { id: '1' } },
      { type: 'image', data: { file: 'base64://' + gif.toString('base64') } },
    ]
  }]);
});

test('estimates require five successful samples per category and survive restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-image-timing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'timing.json');
  const timing = createImageGenerationTiming({ file });
  for (const generationMs of [10_000, 20_000, 30_000, 40_000]) {
    timing.record('reference', { queueMs: 180_000, generationMs, deliveryMs: 1000 });
  }
  assert.deepEqual(timing.estimate('reference'), { reminderMs: 60_000 });
  timing.record('reference', { queueMs: 180_000, generationMs: 50_000, deliveryMs: 1000 });
  const reopened = createImageGenerationTiming({ file });
  assert.deepEqual(reopened.estimate('reference'), { seconds: '35～45', reminderMs: 45_000 });
  for (const category of ['png', 'svg', 'gif']) {
    assert.deepEqual(reopened.estimate(category), { reminderMs: 60_000 });
  }
});

test('uses the requested message and avoids repeat progress before delivering PNG', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new EventEmitter();
  const progress = [];
  const samples = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const tool = createImageGenerationTool({
    captureAuthority: () => ({}), assertAuthority() {},
    paidGuard: () => ({ prepareImage: args => args, dispatch() {}, completeImage() {} }),
    timing: {
      record(category, duration) { samples.push({ category, duration }); },
    },
    async generate() { events.emit('started'); await gate; return { format: 'png', bytes: png }; },
  });
  const ctx = {
    chatKey: 'private:7', assertCurrent() {},
    triggerEntries: [{ mid: '-3', senderId: '7' }, { mid: '4', senderId: '7' }],
    sender: {
      async sendTextBatch(_key, [message], { replyToMessageId, guard }) {
        guard();
        assert.equal(replyToMessageId, '-3');
        progress.push(message);
        events.emit('progress');
      },
      async sendMedia(_key, segments) {
        assert.deepEqual(segments.map(segment => segment.type), ['reply', 'image']);
        assert.equal(segments[0].data.id, '-3');
        events.emit('delivery');
        return { message_id: 8 };
      },
    },
  };
  assert.equal(submit(tool, ctx, 'png').isError, true);
  assert.equal(submit(tool, ctx, 'png', { requestMessageId: '999' }).isError, true);
  const started = once(events, 'started', { signal: AbortSignal.timeout(3000) });
  const accepted = submit(tool, ctx, 'png', { requestMessageId: '-3' });
  assert.match(accepted.content, /已接单/);
  assert.equal(accepted.backgroundJob.tool, 'generate_image');
  assert.ok(accepted.backgroundJob.id);
  await started;
  t.mock.timers.tick(9999);
  assert.deepEqual(progress, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(progress, []);
  const delivered = once(events, 'delivery');
  finish();
  await delivered;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].category, 'png');
  assert.ok(Object.values(samples[0].duration).every(ms => ms >= 0));
});

test('only waiting jobs receive a position, counting active and queued work ahead', async () => {
  const events = new EventEmitter();
  const notices = [];
  let finishFirst;
  const gate = new Promise(resolve => { finishFirst = resolve; });
  const tool = createImageGenerationTool({
    captureAuthority: () => ({}), assertAuthority() {},
    paidGuard: () => ({ prepareImage: args => args, dispatch() {}, completeImage() {} }),
    timing: { record() {} },
    async generate({ actor: requester }) {
      if (requester === '1') { events.emit('started'); await gate; }
      return { format: 'png', bytes: png };
    },
  });
  const sender = {
    async sendTextBatch(key, [text], options) {
      options.guard();
      notices.push([key, text, options.replyToMessageId]);
      events.emit(key);
    },
    async sendMedia(key) { events.emit('delivered:' + key); return { message_id: 9 }; },
  };
  const chats = ['1', '2', '3'].map(id => ({
    chatKey: `private:${id}`, triggerEntries: [{ mid: id, senderId: id }], sender, assertCurrent() {},
  }));
  const started = once(events, 'started', { signal: AbortSignal.timeout(3000) });
  for (const chat of chats) assert.match(submit(tool, chat, 'png').content, /已接单/);
  await started;
  assert.deepEqual(notices, [
    ['private:2', '接到了，前面还有 1 张，轮到就开画。', '2'],
    ['private:3', '接到了，前面还有 2 张，轮到就开画。', '3'],
  ]);
  const lastDelivered = once(events, 'delivered:private:3', { signal: AbortSignal.timeout(3000) });
  finishFirst();
  await lastDelivered;
  assert.equal(notices.length, 2);
});

test('acknowledges immediately, deduplicates, and delivers through the original chat with isolated funding context', async () => {
  const events = new EventEmitter();
  const settlements = [];
  const delivered = [];
  const notices = [];
  const funding = [];
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const sender = new SendQueue({
    onebot: {
      async sendSegments(kind, id, segments) {
        delivered.push([kind, id, segments]);
        events.emit('delivery');
        return { message_id: 1 };
      },
      async call(action, params) {
        delivered.push([action, params.user_id, params.file]);
        events.emit('delivery');
        return { file_id: 'file' };
      },
      async sendText(kind, id, message, { replyToMessageId }) {
        notices.push([kind, id, message, replyToMessageId]);
        return { message_id: 2 };
      },
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
  const group = { chatKey: 'group:101', triggerEntries: [{ mid: '9', senderId: '7' }], sender, assertCurrent() {} };
  const privateChat = { ...group, chatKey: 'private:202', triggerEntries: [{ mid: '10', senderId: '202' }] };
  assert.match(submit(tool, group, 'gif').content, /已接单/);
  assert.equal(submit(tool, group, 'png').isError, true);
  assert.match(submit(tool, privateChat, 'svg').content, /已接单/);
  assert.equal(delivered.length, 0);
  const first = once(events, 'delivery', { signal: AbortSignal.timeout(5000) });
  unblock();
  await first;
  await once(events, 'delivery', { signal: AbortSignal.timeout(5000) });
  await new Promise(resolve => setImmediate(resolve));
  await sender.whenIdle();
  assert.deepEqual(funding, ['group:101', 'private:202']);
  assert.deepEqual(delivered, [
    ['group', '101', [{ type: 'reply', data: { id: '9' } }, { type: 'image', data: { file: 'base64://' + gif.toString('base64') } }]],
    ['upload_private_file', 202, 'base64://' + svg.toString('base64')],
  ]);
  assert.deepEqual(notices.filter(([kind]) => kind === 'group'), []);
  const privateNotices = notices.filter(([kind]) => kind === 'private');
  assert.deepEqual(privateNotices, [
    ['private', '202', '接到了，前面还有 1 张，轮到就开画。', '10'],
  ]);
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
  assert.match(submit(tool, ctx, 'png').content, /已接单/);
  revoked = true;
  await delay(10);
  assert.equal(calls, 0);
});
