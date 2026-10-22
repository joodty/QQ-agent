import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sender-availability-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { SendQueue } = await import('../src/sender.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
setRuntimeConfig({ ...structuredClone(DEFAULT_CONFIG), send: {
  ...structuredClone(DEFAULT_CONFIG.send), minGapMs: 200, maxGapMs: 200, byLengthMs: 1
} });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('leaving a group during a real queue delay prevents every pending QQ send', async () => {
  let allowed = true;
  let checks = 0;
  let signalWaiting;
  const waiting = new Promise(resolve => { signalWaiting = resolve; });
  const sent = [];
  const recorded = [];
  const queue = new SendQueue({
    onebot: { async sendText(...args) { sent.push(args); return { message_id: 1 }; } },
    store: { appendSelf(...args) { recorded.push(args); } },
    canSend(chatKey) {
      assert.equal(chatKey, 'group:101');
      // First capture, then the first queued item's guard immediately before
      // its real >=200 ms human-style delay. Resolving this promise yields to
      // the test only after the queued callback has entered that await.
      if (++checks === 2) signalWaiting();
      return allowed;
    }
  });
  const pending = queue.sendTextBatch('group:101', ['first', 'second']);
  const rejected = assert.rejects(pending, /CHAT_SEND_DISABLED/);
  await waiting;
  assert.equal(sent.length, 0);
  allowed = false;
  await rejected;
  await queue.whenIdle();
  assert.equal(sent.length, 0);
  assert.equal(recorded.length, 0);
  assert.ok(checks >= 4, 'both the waiting item and the next queued item recheck availability');
});

test('a desktop queue without an availability callback keeps its existing send behavior', async () => {
  const sent = [];
  const recorded = [];
  const queue = new SendQueue({
    onebot: { async sendText(...args) { sent.push(args); return { message_id: 7 }; } },
    store: { appendSelf(...args) { recorded.push(args); } }
  });
  const result = await queue.sendTextBatch('private:101', ['hello']);
  assert.equal(result.sent.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(recorded.length, 1);
});

test('an unavailable chat is rejected before it enters the queue', async () => {
  const queue = new SendQueue({ onebot: {}, store: {}, canSend: () => false });
  await assert.rejects(queue.sendTextBatch('group:101', ['hello']), error => error.code === 'CHAT_SEND_DISABLED');
  await queue.whenIdle();
});
