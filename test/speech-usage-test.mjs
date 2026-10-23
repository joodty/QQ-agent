import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSpeechUsage } from '../src/speech-usage.js';

const now = Date.parse('2026-10-23T16:00:00Z'); // Beijing Oct 24, not UTC Oct 23.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-usage-')), file = path.join(root, 'paid.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let revoked = false, disabled = false;
  const auth = {
    verifyPrincipal(p) { if (disabled || !p?.id) throw Object.assign(Error('login required'), { statusCode: 401 }); return p; },
    listScopes: () => revoked ? [] : ['group:123', 'private:123'],
    canAccess: (p, key) => p.role === 'admin' || !revoked && ['group:123', 'private:123'].includes(key),
    async ensureAccess(p, key) { if (!this.canAccess(p, key)) throw Object.assign(Error('denied'), { statusCode: 403 }); }
  };
  const admin = { id: 'admin', role: 'admin' }, user = { id: 'ordinary', role: 'user' };
  const service = createSpeechUsage({ file, auth, now: () => now });
  function write(records, attrs, other = {}) {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA application_id=1363300423; PRAGMA user_version=1; CREATE TABLE IF NOT EXISTS paid_documents(name TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;');
    const put = db.prepare('INSERT OR REPLACE INTO paid_documents VALUES(?,?)');
    put.run('conversation-budget', JSON.stringify({ version: 1, botId: 'primary', records }));
    put.run('call-attribution', JSON.stringify(attrs));
    for (const [name, body] of Object.entries(other)) put.run(name, JSON.stringify(body));
    db.close();
  }
  return { file, root, service, admin, user, write, revoke: () => { revoked = true; }, disable: () => { disabled = true; }, hash: () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
const row = (id, key = 'group:123', state = 'settled', date = '2026-10-24') => ({ id, key, date, operationId: 'service:speech:' + id, state, amountMicros: 90, actualMicros: state === 'settled' ? 90 : null });
const attr = (key = 'group:123', characters = 3) => ({ key, kind: 'speech', ...(characters === undefined ? {} : { characters }) });

test('a missing ledger gives honest zero without creating SQLite, credentials or guard state', async t => {
  const f = fixture(t), result = await f.service.usage(f.user);
  assert.equal(result.totals.attempts, 0); assert.equal(result.from, '2026-10-18'); assert.equal(result.to, '2026-10-24');
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('only primary speech records count; auxiliary holds, models and seeds never double the totals', async t => {
  const f = fixture(t);
  f.write([row('ok'), row('legacy', 'group:123', 'unknown'), row('not-sent', 'group:123', 'released'), row('waiting', 'private:123', 'reserved'),
    { ...row('model'), operationId: 'llm:round:1' }, { ...row('seed'), operationId: 'seed:fixture' }],
  { ok: attr(), legacy: { key: 'group:123', kind: 'speech' }, 'not-sent': attr(), waiting: attr('private:123', 2), model: { kind: 'model' } },
  { 'speech-subsidy-budget': { records: [row('aux1', 'group:123', 'unknown')] }, 'speech-platform-budget': { records: [row('aux2', 'private:1', 'unknown')] } });
  const before = f.hash(), result = await f.service.usage(f.admin, { days: 1 });
  assert.equal(result.scope, 'platform'); assert.equal(result.totals.attempts, 4); assert.equal(result.totals.dispatched, 2);
  assert.equal(result.totals.succeeded, 1); assert.equal(result.totals.unknown, 1); assert.equal(result.totals.released, 1); assert.equal(result.totals.inflight, 1);
  assert.equal(result.totals.estimatedCny, .00009); assert.equal(result.totals.reservedCny, .00018); assert.equal(result.totals.unknownCny, .00009);
  assert.equal(result.totals.characters, null); assert.equal(result.totals.charactersUnknownAttempts, 1); assert.equal(result.totals.knownCharacters, 8);
  assert.equal(result.totals.succeededCharacters, 3); assert.equal(result.daily.length, 1); assert.equal(result.conversationCount, 2);
  assert.equal(f.hash(), before); assert.match(result.estimationBoundary, /辅助额度账不重复/); assert.match(result.characterBoundary, /不代表QQ已送达/);
});

test('typed group/private keys and fresh resource permissions apply equally to historical usage', async t => {
  const f = fixture(t);
  f.write([row('group'), row('private', 'private:123'), row('foreign', 'group:999')], { group: attr(), private: attr('private:123', 4), foreign: attr('group:999', 5) });
  assert.equal((await f.service.usage(f.user)).totals.attempts, 2);
  assert.equal((await f.service.usage(f.user, { chatKey: 'private:123' })).totals.characters, 4);
  assert.equal((await f.service.usage(f.user, { chatKey: 'group:123' })).totals.characters, 3);
  await assert.rejects(f.service.usage(f.user, { chatKey: 'group:999' }), { statusCode: 403 });
  f.revoke(); assert.equal((await f.service.usage(f.user)).totals.attempts, 0);
  await assert.rejects(f.service.usage(f.user, { chatKey: 'group:123' }), { statusCode: 403 });
  f.disable(); await assert.rejects(f.service.usage(f.admin), { statusCode: 401 });
});

test('Beijing creation dates retain cross-day unknowns on their original day; bounded ranges reject invalid input', async t => {
  const f = fixture(t); f.write([row('old', 'group:123', 'unknown', '2026-10-23'), row('new')], { old: attr(), new: attr() });
  assert.equal((await f.service.usage(f.admin, { days: 1 })).totals.attempts, 1);
  const old = await f.service.usage(f.admin, { from: '2026-10-23', to: '2026-10-23' }); assert.equal(old.totals.unknownCny, .00009);
  for (const input of [{ days: '7' }, { days: 365 }, { from: '2026-02-30' }, { to: '2026-10-25' }, { from: '2026-01-01' }, { chatKey: 'group:0123' }, { chatKey: 'group:123 OR 1=1' }, { botId: 'other' }]) await assert.rejects(f.service.usage(f.admin, input), { statusCode: 400 });
});

test('unknown character coverage is preserved across restart without exposing attribution secrets or body data', async t => {
  const f = fixture(t); f.write([row('one', 'group:123', 'unknown')], { one: { ...attr(), characters: undefined, secretKey: 'fixture-hidden-secret', credentialRef: 'fixture-private-reference', text: 'fixture-private-transcript' } });
  const result = await f.service.usage(f.user); assert.equal(result.totals.characters, null); assert.equal(result.totals.charactersUnknownAttempts, 1);
  assert.equal(JSON.stringify(result).includes('fixture-'), false); assert.equal(result.totals.succeeded, 0);
  const repeated = await f.service.usage(f.user); assert.deepEqual(repeated, result);
});

test('corrupt or foreign SQLite fails closed without writing or silently reporting successful zero', async t => {
  const f = fixture(t); f.write([row('one')], { one: attr() });
  const db = new DatabaseSync(f.file); db.prepare("UPDATE paid_documents SET body='not-json' WHERE name='call-attribution'").run(); db.close();
  const hash = f.hash(); await assert.rejects(f.service.usage(f.admin), { statusCode: 503 }); assert.equal(f.hash(), hash);
});

test('missing attribution for a speech operation is an explicit reporting error, not zero usage', async t => {
  const f = fixture(t); f.write([row('one')], {}); const before = f.hash();
  await assert.rejects(f.service.usage(f.admin), { statusCode: 503 }); assert.equal(f.hash(), before);
});

test('a large historical ledger aggregates into bounded daily and conversation summaries', async t => {
  const f = fixture(t), records = [], attrs = {};
  for (let i = 0; i < 10000; i++) { const key = 'group:' + (100 + i % 250); records.push(row('r' + i, key)); attrs['r' + i] = attr(key, 3); }
  f.write(records, attrs); const result = await f.service.usage(f.admin, { days: 1 });
  assert.equal(result.totals.attempts, 10000); assert.equal(result.totals.characters, 30000); assert.equal(result.totals.estimatedCny, .9);
  assert.equal(result.daily.length, 1); assert.equal(result.conversations.length, 200); assert.equal(result.conversationCount, 250); assert.equal(result.conversationsTruncated, true);
});
