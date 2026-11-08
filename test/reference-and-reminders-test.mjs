import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'qq-agent-reference-test-'));
process.env.QQ_AGENT_DATA_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));
const { loadReferenceImage } = await import('../src/qq-request-media.js');
const { createOpenAiImageProvider } = await import('../src/image-generation-provider.js');
const { ReminderStore } = await import('../src/reminders.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { buildToolDefs } = await import('../src/tools.js');
const { SendQueue } = await import('../src/sender.js');
const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

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
