import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXNotificationRelay } from '../src/x-notification-relay.js';

test('relay fixes author and recipient, persists deduplication, and stops on revoked ownership', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-agent-xrelay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'relay.sqlite');
  const settings = { token: 'a'.repeat(64), author: 'example', accountId: 'b'.repeat(32) };
  let owner = 'private:101';
  let calls = 0;
  const options = { settings, file, ownerChat: () => owner, async deliver(chat, text, { guard, beforeDispatch }) {
    assert.equal(chat, 'private:101');
    assert.match(text, /https:\/\/x.com\/example\/status\/10000000001$/);
    assert.equal(guard(), true);
    beforeDispatch();
    calls++;
  } };
  const input = { id: 'd'.repeat(64), author: 'example', postedAt: Date.now(), preview: 'public post', postId: '10000000001', recipient: 'group:202' };
  let relay = createXNotificationRelay(options);
  assert.equal(relay.authorized('Bearer ' + settings.token), true);
  assert.equal(relay.authorized('Bearer wrong'), false);
  assert.equal((await relay.accept({ ...input, author: 'other' })).status, 400);
  assert.equal((await relay.accept(input)).status, 200);
  relay.close();
  relay = createXNotificationRelay(options);
  try {
    assert.deepEqual(await relay.accept({ ...input, id: 'e'.repeat(64) }), { status: 200, duplicate: true });
    owner = null;
    assert.equal((await relay.accept({ ...input, postId: '10000000002' })).status, 403);
    assert.equal(calls, 1);
  } finally { relay.close(); }
});
