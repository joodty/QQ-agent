import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'qq-agent-reference-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));
const { loadReferenceImage, loadChatMessage } = await import('../src/qq-request-media.js');
const { createOpenAiImageProvider } = await import('../src/image-generation-provider.js');
const { ReminderStore } = await import('../src/reminders.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { buildToolDefs } = await import('../src/tools.js');
const { SendQueue } = await import('../src/sender.js');
const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('quoted messages missing from history are read in scope and merged forwards can be expanded', async () => {
  let fetched = 0;
  const ctx = {
    chatKey: 'group:101', triggerEntries: [{ mid: '90', senderId: '10', reply: { mid: '-12' } }],
    store: { findByMid() { return null; }, updateByMid() { return false; } },
    onebot: {
      async getMsg(mid) {
        fetched++;
        assert.equal(String(mid), '-12');
        return { message_type: 'group', group_id: 101, time: 1700000000,
          sender: { user_id: 10, nickname: 'A' },
          message: [{ type: 'image', data: { url: 'https://example.test/a.png' } }, { type: 'forward', data: {} }],
        };
      },
      async call(action, args) {
        assert.equal(action, 'get_forward_msg');
        assert.equal(args.message_id, -12);
        return { messages: [{ sender: { user_id: 10, nickname: 'A' },
          content: [{ type: 'text', data: { text: '周五八点集合' } }] }] };
      },
    },
  };
  const message = await loadChatMessage(ctx, '-12');
  assert.equal(message.media[0].url, 'https://example.test/a.png');
  await assert.rejects(loadChatMessage(ctx, '999'), /找不到/);
  assert.equal(fetched, 1, 'An arbitrary id cannot query QQ');
  await assert.rejects(loadChatMessage({ ...ctx, chatKey: 'group:102' }, '-12'), /无法读取/);
  await assert.rejects(loadChatMessage({ ...ctx, chatKey: 'private:10' }, '-12'), /无法读取/);
  const defs = buildToolDefs();
  const detail = await defs.find(d => d.id === 'get_message_detail').execute(ctx, { messageId: '-12' });
  assert.match(detail.content, /合并转发/);
  const expanded = await defs.find(d => d.id === 'read_forward').execute(ctx, { messageId: '-12' });
  assert.match(expanded.content, /周五八点集合/);
});

test('a reminder can be moved or snoozed by its owner, persists and ignores stale firing completion', async () => {
  const reminders = new ReminderStore();
  const original = reminders.add({ chatKey: 'group:105', text: '开会', dueAt: Date.now() + 60_000, createdBy: '200', requestMessageId: '40' });
  const defs = buildToolDefs();
  const change = defs.find(d => d.id === 'reschedule_reminder');
  const ctx = { chatKey: 'group:105', reminders, triggerEntries: [{ mid: '41', senderId: '200' }] };
  const args = { id: original.id, delayMinutes: 10 };
  assert.equal((await change.execute({ ...ctx, chatKey: 'group:106' }, args)).isError, true);
  assert.equal((await change.execute({ ...ctx, triggerEntries: [{ mid: '42', senderId: '100' }] }, args)).isError, true);
  assert.equal((await change.execute(ctx, { ...args, delayMinutes: -1 })).isError, true);
  assert.equal((await change.execute(ctx, args)).isError, undefined);
  const moved = reminders.pending(ctx.chatKey)[0];
  assert.ok(moved.dueAt > original.dueAt);
  assert.equal(reminders.markFired(original.id, original), false);
  assert.equal(new ReminderStore().pending(ctx.chatKey)[0].dueAt, moved.dueAt);
  await change.execute(ctx, { ...args, delayMinutes: 20 });
  assert.equal(reminders.pending(ctx.chatKey)[0].dueAt, moved.dueAt);
  reminders.markFired(moved.id);
  const list = await defs.find(d => d.id === 'list_reminders').execute(ctx, { includeRecent: true });
  assert.match(list.content, /已触发/);
  assert.match(list.content, /200/);
  await change.execute({ ...ctx, triggerEntries: [{ mid: '43', senderId: '200' }] }, args);
  const restored = new ReminderStore().pending(ctx.chatKey);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, original.id);
  reminders.cancel(original.id, ctx.chatKey, '200');
});

test('uploads the actual reference bytes to the edit endpoint', async () => {
  const url = 'https://example.test/reference.png';
  const ctx = { chatKey: 'group:101', onebot: { async getMsg(mid) {
    assert.equal(mid, '-12');
    return { message_type: 'group', group_id: 101, message: [{ type: 'image', data: { url } }] };
  } } };
  const referenceImage = await loadReferenceImage(ctx, { reply: { mid: '-12' } }, async actual => {
    assert.equal(actual, url);
    return { buffer: bytes };
  });
  const generate = createOpenAiImageProvider({ apiKey: 'fake', async fetchImpl(endpoint, options) {
    assert.equal(endpoint, 'https://api.openai.com/v1/images/edits');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.images, [{ image_url: 'data:image/png;base64,' + bytes.toString('base64') }]);
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  } });
  const result = await generate({ prompt: 'Change the background', format: 'png', size: '1024x1024', actor: 'fixture', referenceImage });
  assert.deepEqual(result.bytes, bytes);
  await assert.rejects(loadReferenceImage({ ...ctx, chatKey: 'group:102' }, { reply: { mid: '-12' } }, assert.fail), /当前聊天/);
  await assert.rejects(loadReferenceImage(ctx, { media: [{ kind: 'image', url }, { kind: 'image', url }] }, assert.fail), /一张/);
});

test('reminders use the requesting sender, survive reload, and are cancellable only in scope', async () => {
  const reminders = new ReminderStore();
  const defs = buildToolDefs();
  const set = defs.find(d => d.id === 'set_reminder');
  const cancel = defs.find(d => d.id === 'cancel_reminder');
  const ctx = { chatKey: 'group:101', reminders, triggerEntries: [
    { mid: '1', senderId: '100' }, { mid: '-2', senderId: '200' }
  ] };
  assert.equal((await set.execute(ctx, { text: '起床', delayMinutes: 1 })).isError, true);
  const args = { text: '起床', delayMinutes: 1, requestMessageId: '-2' };
  await set.execute(ctx, args);
  await set.execute(ctx, args);
  const [entry, duplicate] = new ReminderStore().pending('group:101');
  assert.equal(entry.createdBy, '200');
  assert.equal(duplicate, undefined);
  assert.equal((await cancel.execute(ctx, { id: entry.id, requestMessageId: '1' })).isError, true);
  assert.equal((await cancel.execute({ ...ctx, chatKey: 'group:102' }, { id: entry.id, requestMessageId: '-2' })).isError, true);
  assert.equal((await cancel.execute(ctx, { id: entry.id, requestMessageId: '-2' })).isError, undefined);
});

test('scheduled QQ dispatch mentions each group requester and sends private reminders without mentions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reminders = new ReminderStore();
  const add = (chatKey, createdBy) => reminders.add({ chatKey, text: '起床', dueAt: Date.now() - 1, createdBy, requestMessageId: '3' });
  add('group:101', '100');
  add('group:101', '200');
  add('private:300', '300');
  const calls = [];
  const onebot = { async sendText(kind, id, text, { atUserId }) {
    calls.push([kind, id, atUserId]);
    return { message_id: calls.length };
  } };
  const sender = new SendQueue({ onebot, store: { appendSelf() {} } });
  const orchestrator = new Orchestrator({ reminders, sender });
  t.after(() => orchestrator.stopReminderLoop());
  orchestrator.startReminderLoop();
  t.mock.timers.tick(5000);
  for (let i = 0; i < 15 && reminders.pending().length; i++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10000);
  }
  assert.deepEqual(calls, [['group', '101', '100'], ['group', '101', '200'], ['private', '300', null]]);
  assert.equal(reminders.pending().length, 0);
});
