import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { exportLegacyArchives } from '../src/legacy-archive-export.js';
import { ConversationArchives, validateArchiveBundle } from '../src/conversation-archives.js';

// All identities and conversation bodies below are artificial offline fixtures.
const PA = 'p_' + 'a'.repeat(32), PB = 'p_' + 'b'.repeat(32);
const CA = 'c_' + 'a'.repeat(32), CB = 'c_' + 'b'.repeat(32);
const SID = 'fixture-root-session';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-legacy-export-test-'));
  const bridgeRoot = path.join(temp, 'bridge'), dshExportsDir = path.join(temp, 'dsh');
  fs.mkdirSync(path.join(bridgeRoot, 'state'), { recursive: true }); fs.mkdirSync(dshExportsDir);
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'qq-legacy-export-test-')));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  function write(relative, value, root = bridgeRoot) {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); return target;
  }
  function sqlite(rows, { wal = false } = {}) {
    const db = new DatabaseSync(path.join(bridgeRoot, 'state', 'manager.sqlite')); handles.push(db);
    db.exec('PRAGMA application_id=0x51514254; PRAGMA user_version=1; CREATE TABLE state_documents(path TEXT PRIMARY KEY,kind TEXT NOT NULL,bot_id TEXT NOT NULL,raw_text TEXT,revision INTEGER NOT NULL,migrated_at INTEGER NOT NULL)');
    if (wal) db.exec('PRAGMA journal_mode=WAL');
    const insert = db.prepare('INSERT INTO state_documents VALUES(?,?,?,?,?,0)');
    for (const row of rows) insert.run(row.path, row.kind, row.botId || 'primary', row.value === null ? null : typeof row.value === 'string' ? row.value : JSON.stringify(row.value), row.revision || 1);
    return db;
  }
  return { temp, bridgeRoot, dshExportsDir, handles, write, sqlite,
    export: extra => exportLegacyArchives({ bridgeRoot, sourceId: 'fixture-source', ...extra }) };
}
function index({ second = false, sid = SID, selected = CA, deleted = false, blocked = false, missing = false } = {}) {
  return { version: 1, personas: { [PA]: { name: 'A', deleted }, ...(second ? { [PB]: { name: 'B', deleted: false } } : {}) },
    records: { [CA]: { key: 'group:12345', personaId: PA, sessionId: sid, createdAt: 10, lastUsedAt: 20, blocked, missing, policy: 'fixture-policy' },
      ...(second ? { [CB]: { key: 'group:12345', personaId: PB, sessionId: null, createdAt: 11, lastUsedAt: 21, blocked: false, missing: false, policy: null } } : {}) }, selected: { 'group:12345': selected } };
}
function base(f, options) { f.write('roles/A.md', 'Fixture persona A'); f.write('state/conversation-sessions.json', index(options)); }
function inbound(text = 'Fixture group message', extra = {}) { return { messageId: 'fixture-mid', sender: 'Fixture friend', userId: '10001', plain: text, text, isSelf: false, time: 1000, seq: 1, media: [], ...extra }; }
function social(conversations = { 'group:12345': { recentMessages: [inbound()], unread: [inbound()] } }) { return { conversations }; }
function artifact({ id = SID, parentSession, events, tail = '' } = {}) {
  const header = { id, version: 1, createdAt: 1, ...(parentSession ? { parentSession } : {}) };
  const body = events || [
    { seq: 0, type: 'turn/start', data: { turn: 0 } },
    { seq: 1, type: 'user/message', data: { content: 'Fixture original model input' } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Fixture original model output' }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 0 } },
  ];
  return [header, ...body].map(row => JSON.stringify(row)).join('\n') + '\n' + tail;
}
function hashes(root) {
  const rows = {};
  function walk(dir, relative = '') { for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), child = relative ? relative + '/' + name : name, stat = fs.lstatSync(file);
    if (stat.isDirectory()) walk(file, child); else if (stat.isFile()) rows[child] = digest(fs.readFileSync(file));
  } }
  walk(root); return rows;
}

test('JSON export preserves stable persona/archive IDs, read native messages and A/B attribution', t => {
  const f = fixture(t); base(f, { second: true }); f.write('roles/B.md', 'Fixture persona B'); f.write('state/social-v2.json', social());
  const before = hashes(f.bridgeRoot), bundle = f.export();
  validateArchiveBundle(bundle); assert.deepEqual(hashes(f.bridgeRoot), before);
  assert.equal(bundle.personas.find(row => row.id === PA).content, 'Fixture persona A');
  assert.deepEqual(bundle.archives.map(row => row.id), [CA, CB]); assert.deepEqual(bundle.selected, [{ chatKey: 'group:12345', archiveId: CA }]);
  assert.equal(bundle.archives[0].messages.length, 1); assert.equal(bundle.archives[0].messages[0].read, true);
  assert.equal(bundle.archives[1].messages.length, 0); assert.equal(bundle.coverage.qqMessages.status, 'partial');
  assert.equal(bundle.coverage.dshTranscripts[0].status, 'missing'); assert.equal(bundle.coverage.status, 'missing');
  assert.equal(bundle.coverage.sourceWritten, false); assert.equal(bundle.coverage.credentialStoresRead, false);
});

test('exported bundle imports into canonical SQLite archive store without changing its data', t => {
  const f = fixture(t); base(f); f.write('state/social-v2.json', social());
  f.write('root.jsonl', artifact(), f.dshExportsDir);
  const bundle = f.export({ dshExportsDir: f.dshExportsDir });
  const store = new ConversationArchives({ file: path.join(f.temp, 'destination.sqlite') }); f.handles.push(store);
  assert.equal(store.importBundle(bundle, { dryRun: false }).archivesAdded, 1);
  assert.equal(store.active('group:12345').archiveId, CA);
  assert.deepEqual(store.readChat('group:12345').messages, bundle.archives[0].messages);
  assert.deepEqual(store.transcript('group:12345'), bundle.archives[0].transcript);
});

test('SQLite authoritative values override stale JSON/Markdown while unrelated credential documents stay unread', t => {
  const f = fixture(t); base(f); f.write('state/conversation-sessions.json', '{invalid stale JSON'); f.write('roles/A.md', 'stale role must not win');
  f.sqlite([
    { path: 'state/conversation-sessions.json', kind: 'conversation-sessions', value: index() },
    { path: 'roles/A.md', kind: 'role-card', value: 'SQLite authoritative persona' },
    { path: 'state/accounts.json', kind: 'accounts', value: { secret: 'FIXTURE_ACCOUNT_SENTINEL_NEVER_EXPORT' } },
    { path: 'state/billing-profiles.json', kind: 'billing-profiles', value: { secret: 'FIXTURE_KEY_SENTINEL_NEVER_EXPORT' } },
  ]);
  const before = hashes(f.bridgeRoot), bundle = f.export(), encoded = JSON.stringify(bundle);
  assert.equal(bundle.personas[0].content, 'SQLite authoritative persona'); assert.equal(bundle.coverage.authority.startsWith('sqlite-'), true);
  assert.equal(encoded.includes('FIXTURE_ACCOUNT_SENTINEL'), false); assert.equal(encoded.includes('FIXTURE_KEY_SENTINEL'), false);
  assert.deepEqual(hashes(f.bridgeRoot), before); assert.equal(bundle.coverage.sourceFiles.some(row => row.path === 'roles/A.md'), false);
});

test('SQLite WAL snapshot exports latest committed target rows without source file or sidecar mutation', t => {
  const f = fixture(t); f.sqlite([
    { path: 'state/conversation-sessions.json', kind: 'conversation-sessions', value: index() },
    { path: 'roles/A.md', kind: 'role-card', value: 'Latest WAL role' },
  ], { wal: true });
  const before = hashes(f.bridgeRoot), bundle = f.export();
  assert.equal(bundle.personas[0].content, 'Latest WAL role'); assert.deepEqual(hashes(f.bridgeRoot), before);
  assert.ok(bundle.coverage.sourceFiles.some(row => row.path.endsWith('-wal')));
});

test('SQLite tombstones and absent managed rows do not resurrect frozen role or BYOK JSON', t => {
  const f = fixture(t); base(f); f.write('state/byok-conversations.json', { version: 1, archives: [{ id: 'stale-history' }] });
  f.sqlite([
    { path: 'state/conversation-sessions.json', kind: 'conversation-sessions', value: index({ sid: null }) },
    { path: 'roles/A.md', kind: 'role-card', value: null },
  ]);
  const bundle = f.export(); assert.equal(bundle.personas[0].content, ''); assert.equal(bundle.archives.length, 1);
  assert.ok(bundle.coverage.issues.some(row => row.reason === 'persona-content-missing'));
  assert.equal(bundle.coverage.sourceFiles.some(row => row.path === 'state/byok-conversations.json'), false);
});

test('member persona current version, internal role association and historical versions remain intact', t => {
  const f = fixture(t), memberId = 'd'.repeat(32), internal = 'member_' + memberId, old = index({ sid: null });
  old.personas[PA].name = internal;
  f.write('state/conversation-sessions.json', old); f.write('roles/' + internal + '.md', 'mirror content');
  const history = [{ version: 1, name: 'Old fixture name', content: 'Old fixture body', createdAt: 5, authorUserId: 'fixture-owner' }];
  f.write('state/member-personas.json', { version: 1, cards: [{ id: memberId, internalRoleName: internal, botId: 'primary', ownerUserId: 'fixture-owner', name: 'Current fixture name', content: 'Current fixture body', version: 2, createdAt: 5, updatedAt: 10, history }] });
  const bundle = f.export(), card = bundle.personas.find(row => row.id === PA);
  assert.equal(card.name, 'Current fixture name'); assert.equal(card.version, 2); assert.equal(card.content, 'Current fixture body');
  assert.deepEqual(card.history.slice(1), history); assert.equal(card.history[0].id, memberId); assert.equal(bundle.archives[0].personaId, PA);
});

test('a default DSH persona with unavailable preset body is retained but cannot claim original-persona continuation', t => {
  const f = fixture(t), old = index({ sid: null }); old.personas[PA].name = null;
  f.write('state/conversation-sessions.json', old); const bundle = f.export();
  assert.deepEqual(bundle.personas[0], { id: PA, name: '', content: '', version: 1, history: [] });
  assert.equal(bundle.coverage.issues.some(row => row.reason === 'default-dsh-preset-content-not-exported'), true);
  assert.equal(bundle.coverage.personas[0].status, 'missing'); assert.equal(bundle.archives[0].continuation, 'missing');
});

test('missing persona bodies and old inactive flags survive canonical import without becoming active', t => {
  const f = fixture(t); base(f, { second: true, selected: CB, blocked: true });
  const bundle = f.export(); assert.equal(bundle.archives.find(row => row.id === CA).continuation, 'blocked');
  assert.equal(bundle.archives.find(row => row.id === CB).continuation, 'missing');
  assert.equal(bundle.coverage.personas.find(row => row.personaId === PB).status, 'missing');
  const store = new ConversationArchives({ file: path.join(f.temp, 'inactive.sqlite') }); f.handles.push(store);
  const result = store.importBundle(bundle, { dryRun: false }); assert.equal(result.selectionsBlocked, 1);
  assert.equal(store.active('group:12345'), null);
  assert.equal(store.snapshot('group:12345', CB).continuation, 'missing');
  assert.throws(() => store.select('group:12345', CB, { expectedVersion: 0 }), { statusCode: 409 });
  f.write('state/conversation-sessions.json', index({ deleted: true, missing: true, blocked: true }));
  assert.equal(f.export().archives[0].continuation, 'deleted-persona');
});

test('group and private conversations sharing the same number and a second group stay isolated', t => {
  const f = fixture(t); f.write('state/social-v2.json', social({
    'group:12345': { recentMessages: [inbound('Group A')], unread: [] },
    'private:12345': { recentMessages: [inbound('Private A')], unread: [] },
    'group:67890': { recentMessages: [inbound('Group B')], unread: [] },
  }));
  const bundle = f.export(); assert.equal(bundle.archives.length, 3);
  assert.deepEqual(bundle.archives.map(row => [row.chatKey, row.messages[0].text]), [['group:12345', 'Group A'], ['private:12345', 'Private A'], ['group:67890', 'Group B']]);
  assert.equal(new Set(bundle.archives.map(row => row.id)).size, 3); validateArchiveBundle(bundle);
});

test('the same DSH identity cannot be assigned to two archives or cross-chat active mappings', t => {
  const f = fixture(t), old = index({ second: true }); old.records[CB].sessionId = SID;
  f.write('state/conversation-sessions.json', old); assert.throws(() => f.export(), { code: 'CROSS_CONVERSATION' });
  f.write('state/conversation-sessions.json', index()); f.write('state/sessions.json', { sessions: { 'private:12345': SID } });
  assert.throws(() => f.export(), { code: 'CROSS_CONVERSATION' });
});

test('DSH complete raw artifact preserves over 200 full messages and does not invent native QQ deliveries', t => {
  const f = fixture(t); base(f);
  const events = [{ seq: 0, type: 'turn/start', data: {} }];
  for (let i = 0; i < 250; i++) events.push({ seq: events.length, type: i % 2 ? 'assistant/message' : 'user/message', data: { content: 'Fixture message ' + i + ': ' + 'x'.repeat(350) } });
  events.push({ seq: events.length, type: 'turn/end', data: {} }); f.write('session.jsonl', artifact({ events }), f.dshExportsDir);
  const before = hashes(f.dshExportsDir), bundle = f.export({ dshExportsDir: f.dshExportsDir });
  const projection = bundle.archives[0].transcript.filter(row => row.kind === 'legacy-message');
  assert.equal(projection.length, 250); assert.ok(projection[249].text.length > 350); assert.equal(bundle.archives[0].messages.length, 0);
  assert.equal(bundle.coverage.dshTranscripts[0].status, 'complete'); assert.equal(bundle.coverage.qqMessages.status, 'missing');
  assert.equal(bundle.coverage.status, 'partial'); assert.deepEqual(hashes(f.dshExportsDir), before);
});

test('offline SessionRawArtifact wrapper and descendants are retained as passive transcript data', t => {
  const f = fixture(t); base(f); const content = artifact();
  f.write('root.artifact.json', { meta: { id: SID, version: 1, createdAt: 1 }, filename: 'session.jsonl', content }, f.dshExportsDir);
  f.write('subagents/fixture-child/session.jsonl', artifact({ id: 'fixture-child', parentSession: SID }), f.dshExportsDir);
  const bundle = f.export({ dshExportsDir: f.dshExportsDir });
  assert.equal(bundle.coverage.dshTranscripts[0].descendants, 1);
  assert.equal(bundle.archives[0].transcript.filter(row => row.kind === 'legacy-dsh-header').length, 2);
  assert.equal(bundle.archives[0].transcript.filter(row => row.kind === 'legacy-message').length, 4);
});

test('truncated or gapped DSH exports are partial and preserve unparsed raw tail instead of repairing it', t => {
  const f = fixture(t); base(f); f.write('session.jsonl', artifact({ tail: '{"type":"fixture-torn' }), f.dshExportsDir);
  const before = hashes(f.dshExportsDir), bundle = f.export({ dshExportsDir: f.dshExportsDir });
  assert.equal(bundle.coverage.dshTranscripts[0].status, 'partial');
  assert.equal(bundle.archives[0].transcript.at(-1).rawText, '{"type":"fixture-torn'); assert.deepEqual(hashes(f.dshExportsDir), before);
  f.write('session.jsonl', artifact({ events: [{ seq: 3, type: 'user/message', data: { content: 'gap' } }] }), f.dshExportsDir);
  assert.equal(f.export({ dshExportsDir: f.dshExportsDir }).coverage.dshTranscripts[0].status, 'partial');
});

test('a partial descendant makes root coverage partial and mismatched/unknown artifact formats fail explicitly', t => {
  const f = fixture(t); base(f); f.write('session.jsonl', artifact(), f.dshExportsDir);
  f.write('child.jsonl', artifact({ id: 'fixture-child', parentSession: SID, tail: '{' }), f.dshExportsDir);
  assert.equal(f.export({ dshExportsDir: f.dshExportsDir }).coverage.dshTranscripts[0].status, 'partial');
  fs.unlinkSync(path.join(f.dshExportsDir, 'child.jsonl'));
  f.write('unknown.jsonl', JSON.stringify({ type: 'provider-specific-header', value: 'do not guess' }) + '\n', f.dshExportsDir);
  assert.throws(() => f.export({ dshExportsDir: f.dshExportsDir }), { code: 'DSH_FORMAT' });
});

test('internal model control text is not promoted to native QQ messages or resumable instructions', t => {
  const f = fixture(t); base(f); const token = 'FIXTURE_INTERNAL_TOKEN_123456';
  f.write('state/social-v2.json', social({ 'group:12345': { recentMessages: [inbound('Visible original message')], unread: [], agentToken: token } }));
  f.write('session.jsonl', artifact({ events: [{ seq: 0, type: 'user/message', data: { content: '【会话令牌】' + token + '\n【后台控制端提醒】fixture internal instruction' } }] }), f.dshExportsDir);
  const bundle = f.export({ dshExportsDir: f.dshExportsDir }), projection = bundle.archives[0].transcript.find(row => row.kind === 'legacy-message');
  assert.equal(projection.resumeEligible, false); assert.equal(projection.qqDeliveryProven, false); assert.equal(projection.text.includes(token), false);
  assert.equal(projection.raw.data.content.includes(token), true); assert.equal(bundle.archives[0].messages.length, 1);
  assert.ok(bundle.coverage.issues.some(row => row.reason === 'no-recognized-resumable-plain-text-projection'));
});

test('surface replacements remain raw and explicitly require model-view folding before continuation', t => {
  const f = fixture(t); base(f); f.write('session.jsonl', artifact({ events: [
    { seq: 0, type: 'user/message', data: { content: 'old visible text' } },
    { seq: 1, type: 'assistant/message', data: { content: 'replacement text' }, surfaceOp: { op: 'replace', start: 0 } },
  ] }), f.dshExportsDir);
  const bundle = f.export({ dshExportsDir: f.dshExportsDir }), projections = bundle.archives[0].transcript.filter(row => row.kind === 'legacy-message');
  assert.equal(projections.length, 2); assert.ok(projections.every(row => !row.resumeEligible && row.projectionGap === 'surface-replacement-not-folded'));
  assert.equal(bundle.coverage.dshTranscripts[0].status, 'complete');
  assert.ok(bundle.coverage.issues.some(row => row.reason === 'no-recognized-resumable-plain-text-projection'));
});

test('BYOK bounded model history remains a separate model transcript without fabricated QQ metadata', t => {
  const f = fixture(t); f.write('state/byok-conversations.json', { version: 1, archives: [{ id: 'fixture-byok-archive', botId: 'primary', key: 'private:12345', personaId: PA, ownerUserId: 'fixture-owner', profileId: 'fixture-profile', messages: [{ role: 'user', content: 'Original private model input' }, { role: 'assistant', content: 'Original private model answer' }], updatedAt: 1000 }] });
  const bundle = f.export(), archive = bundle.archives[0]; validateArchiveBundle(bundle);
  assert.equal(archive.id, 'fixture-byok-archive'); assert.equal(archive.messages.length, 0);
  assert.equal(archive.transcript[0].retention.maxMessages, 20); assert.equal(archive.transcript[1].role, 'user');
  assert.equal(bundle.coverage.status, 'partial'); assert.ok(bundle.coverage.issues.some(row => row.reason === 'bounded-byok-history-and-no-original-qq-delivery-record'));
});

test('missing sources, invalid JSON, unsafe managed role paths and invalid chat identities never silently succeed', t => {
  const f = fixture(t); assert.throws(() => f.export(), { code: 'SOURCE_MISSING' });
  f.write('state/conversation-sessions.json', '{'); assert.throws(() => f.export(), { code: 'SOURCE_JSON' });
  f.write('state/conversation-sessions.json', { ...index(), selected: { 'group:00001': CA } }); assert.throws(() => f.export(), { code: 'INVALID_CHAT_KEY' });
  f.sqlite([{ path: 'roles/../../outside.md', kind: 'role-card', value: 'must not follow' }]); assert.throws(() => f.export(), { code: 'UNSAFE_PATH' });
});

test('symlinked source directories and DSH entries are rejected before following them', t => {
  const f = fixture(t); base(f); const outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.jsonl'), artifact());
  const link = path.join(f.dshExportsDir, 'linked');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('OS disallows creating fixture symlinks'); return; } throw error; }
  assert.throws(() => f.export({ dshExportsDir: f.dshExportsDir }), { code: 'UNSAFE_PATH' });
  assert.throws(() => exportLegacyArchives({ bridgeRoot: link, sourceId: 'fixture-source' }), { code: 'UNSAFE_PATH' });
});

test('CLI writes a private new bundle outside source roots, reports only counts and refuses overwrite', t => {
  const f = fixture(t); base(f); const cli = fileURLToPath(new URL('../scripts/export-legacy-archives.mjs', import.meta.url));
  const output = path.join(f.temp, 'bundle.json'), before = hashes(f.bridgeRoot);
  const args = [cli, '--bridge-root', f.bridgeRoot, '--source-id', 'fixture-source', '--output', output];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).ok, true); assert.equal(first.stdout.includes('Fixture persona A'), false);
  validateArchiveBundle(JSON.parse(fs.readFileSync(output, 'utf8'))); assert.deepEqual(hashes(f.bridgeRoot), before);
  const previous = fs.readFileSync(output), second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 1); assert.deepEqual(fs.readFileSync(output), previous);
  const inside = spawnSync(process.execPath, [cli, '--bridge-root', f.bridgeRoot, '--source-id', 'fixture-source', '--output', path.join(f.bridgeRoot, 'must-not-write.json')], { encoding: 'utf8' });
  assert.equal(inside.status, 1); assert.equal(fs.existsSync(path.join(f.bridgeRoot, 'must-not-write.json')), false);
  assert.equal(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).status, 0);
});
