import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ConversationArchives, validateArchiveBundle } from '../src/conversation-archives.js';

function message(id = 1, text = 'fixture archive message') { return { id, mid: id, ts: 1000 + id, senderId: '10001', senderName: 'fixture friend', text, self: false, read: true, reply: null, media: [] }; }
function bundle() { return { format: 'qq-bridge-archives', version: 1, sourceId: 'fixture-source',
  personas: [{ id: 'p-a', name: '角色 A', content: 'A prompt', version: 1, history: [{ version: 1, content: 'A prompt' }] }, { id: 'p-b', name: '角色 B', content: 'B prompt', version: 2, history: [{ version: 1, content: 'B old' }, { version: 2, content: 'B prompt' }] }],
  archives: [{ id: 'a-a', chatKey: 'group:101', personaId: 'p-a', legacySessionId: 'fixture-dsh-a', createdAt: 1, lastUsedAt: 2, messages: [message()], transcript: [{ kind: 'legacy-event', raw: { type: 'tool/call', code: 'fixture inert data', function: 'do-not-execute' } }] },
    { id: 'a-b', chatKey: 'group:101', personaId: 'p-b', legacySessionId: 'fixture-dsh-b', createdAt: 1, lastUsedAt: 2, messages: [message(1, 'B original history')], transcript: [] },
    { id: 'private-a', chatKey: 'private:101', personaId: 'p-a', legacySessionId: null, createdAt: 1, lastUsedAt: 2, messages: [message(1, 'private original history')], transcript: [] }],
  selected: [{ chatKey: 'group:101', archiveId: 'a-a' }, { chatKey: 'private:101', archiveId: 'private-a' }], coverage: { status: 'partial', fixture: { dsh: 'complete', qqMessages: 'partial' } } }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-archives-test-')), file = path.join(root, 'archives.sqlite'), opened = [];
  const create = (botId = 'primary') => { const store = new ConversationArchives({ file, botId }); opened.push(store); return store; };
  t.after(() => { for (const store of opened) if (!store.closed) store.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-archives-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, create, store: create() };
}
function append(store, chatKey, text, archiveId) { const state = store.readChat(chatKey, archiveId), entry = message(state.nextLocalId++, text); entry.read = false; state.messages.push(entry); store.writeChat(state); return state; }
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (process.argv[2] === '--cas-worker') {
  const store = new ConversationArchives({ file: process.argv[3] }), state = store.readChat('group:101');
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
  await new Promise(resolve => process.stdin.once('data', resolve));
  state.messages.push(message(state.nextLocalId++, 'worker-' + process.argv[4])); let accepted = false;
  try { store.writeChat(state); accepted = true; } catch (error) { if (error.statusCode !== 409) throw error; }
  store.close(); process.stdout.write(JSON.stringify({ accepted }) + '\n'); process.exit(0);
}

test('construction, validation and dry run of a missing file create no database or parent directories', t => {
  const f = fixture(t), nested = path.join(f.root, 'not-created', 'archives.sqlite'), store = new ConversationArchives({ file: nested });
  t.after(() => store.close()); const source = bundle(); assert.equal(validateArchiveBundle(source).sourceId, source.sourceId);
  const result = store.importBundle(source); assert.equal(result.dryRun, true); assert.equal(result.archivesAdded, 3); assert.equal(result.messagesAdded, 3);
  assert.equal(fs.existsSync(path.dirname(nested)), false); assert.deepEqual(store.list(), []); assert.equal(store.active('group:101'), null); assert.equal(store.readChat('group:101'), null);
});

test('import preserves source ids, personas, version history and inert raw transcripts', t => {
  const f = fixture(t), source = bundle(), result = f.store.importBundle(source, { dryRun: false });
  assert.equal(result.archivesAdded, 3); assert.deepEqual(result.coverage, source.coverage); assert.equal(f.store.personas()[1].version, 2); assert.deepEqual(f.store.personas()[1].history, source.personas[1].history);
  assert.deepEqual(f.store.transcript('group:101'), source.archives[0].transcript); assert.equal(f.store.snapshot('group:101').legacySessionId, 'fixture-dsh-a');
  assert.deepEqual(f.store.listChats(), ['group:101', 'private:101']); const active = f.store.active('group:101');
  assert.equal(active.archiveId, 'a-a'); assert.equal(active.sourceId, 'fixture-source'); assert.equal(active.selectionVersion, 1); assert.equal(active.persona.content, 'A prompt');
  const metadata = f.store.list('group:101')[0]; assert.deepEqual(metadata.persona, { id: 'p-a', name: '角色 A', version: 1 }); assert.equal(metadata.messages, undefined); assert.equal(metadata.transcript, undefined);
});

test('inactive legacy archives retain all evidence but cannot be selected or written', t => {
  const f = fixture(t), source = bundle();
  source.archives[0].continuation = 'blocked'; source.archives[1].continuation = 'missing'; source.archives[2].continuation = 'deleted-persona';
  const preview = f.store.importBundle(source); assert.equal(preview.selectionsBlocked, 2); assert.equal(fs.existsSync(f.file), false);
  const result = f.store.importBundle(source, { dryRun: false }); assert.equal(result.selectionsAdded, 0); assert.equal(result.selectionsBlocked, 2);
  assert.equal(f.store.active('group:101'), null); assert.equal(f.store.readChat('group:101'), null);
  for (const row of source.archives) {
    assert.equal(f.store.list(row.chatKey).find(value => value.id === row.id).continuation, row.continuation);
    assert.deepEqual(f.store.snapshot(row.chatKey, row.id).messages, row.messages); assert.deepEqual(f.store.transcript(row.chatKey, row.id), row.transcript);
    assert.equal(f.store.snapshot(row.chatKey, row.id).continuation, row.continuation);
    const state = f.store.readChat(row.chatKey, row.id); assert.deepEqual(state.messages, row.messages);
    assert.throws(() => f.store.select(row.chatKey, row.id, { expectedVersion: 0 }), { statusCode: 409 });
    assert.throws(() => f.store.writeChat(state), { statusCode: 409 });
  }
  assert.equal(f.store.importBundle(source, { dryRun: false }).selectionsBlocked, 2);
  const db = new DatabaseSync(f.file, { readOnly: true }); try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM archive_imports WHERE kind='selection'").get().n, 2);
  } finally { db.close(); }
  const changed = structuredClone(source); changed.archives[0].continuation = 'ready';
  assert.throws(() => f.store.importBundle(changed, { dryRun: false }), { statusCode: 409 });
});

test('default ready continuation is canonical and invalid continuation fails without creating a file', t => {
  const f = fixture(t), source = bundle();
  assert.equal(validateArchiveBundle(source).archives[0].continuation, 'ready'); assert.equal(source.archives[0].continuation, undefined);
  source.archives[0].continuation = 'true'; assert.throws(() => f.store.importBundle(source, { dryRun: false }), { statusCode: 400 }); assert.equal(fs.existsSync(f.file), false);
  source.archives[0].continuation = 'ready'; f.store.importBundle(source, { dryRun: false }); delete source.archives[0].continuation;
  assert.equal(f.store.importBundle(source, { dryRun: false }).archivesUpdated, 0); assert.equal(f.store.list()[0].continuation, 'ready');
});

test('existing-file dry run uses a read-only transaction and leaves all bytes unchanged', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); f.store.close(); const hash = digest(f.file), reopened = f.create(), source = bundle();
  source.archives.push({ ...source.archives[0], id: 'new-only-dry-run', messages: [], transcript: [] });
  assert.equal(reopened.importBundle(source).archivesAdded, 1); assert.equal(digest(f.file), hash); assert.equal(reopened.list().length, 3);
});

test('A to B to A restores each persona history independently and persists across restart', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); append(f.store, 'group:101', 'A new message');
  assert.equal(f.store.select('group:101', 'a-b', { expectedVersion: 1 }).selectionVersion, 2); append(f.store, 'group:101', 'B new message');
  assert.equal(f.store.select('group:101', 'a-a', { expectedVersion: 2 }).selectionVersion, 3); assert.deepEqual(f.store.readChat('group:101').messages.map(row => row.text), ['fixture archive message', 'A new message']);
  assert.equal(f.store.readChat('group:101', 'a-b').messages.at(-1).text, 'B new message'); f.store.close(); const reopened = f.create();
  assert.equal(reopened.active('group:101').selectionVersion, 3); assert.equal(reopened.readChat('group:101').messages.at(-1).text, 'A new message');
  assert.equal(reopened.readChat('private:101').messages[0].text, 'private original history');
});

test('selection CAS rejects stale and cross-conversation changes while same-id selection is idempotent', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); assert.equal(f.store.select('group:101', 'a-a', { expectedVersion: 1 }).selectionVersion, 1);
  f.store.select('group:101', 'a-b', { expectedVersion: 1 }); assert.throws(() => f.store.select('group:101', 'a-a', { expectedVersion: 1 }), { statusCode: 409 });
  assert.throws(() => f.store.select('group:101', 'private-a'), { statusCode: 404 }); assert.throws(() => f.store.readChat('private:101', 'a-b'), { statusCode: 404 });
  assert.throws(() => f.store.select('group:01', 'a-a'), { statusCode: 400 }); assert.equal(f.store.active('group:101').archiveId, 'a-b');
});

test('a first explicit selection accepts expectedVersion zero without creating an unmanaged default', t => {
  const f = fixture(t), source = bundle(); source.selected = []; f.store.importBundle(source, { dryRun: false });
  assert.equal(f.store.readChat('group:101'), null); assert.equal(f.store.listChats().length, 2);
  assert.equal(f.store.select('group:101', 'a-b', { expectedVersion: 0 }).selectionVersion, 1); assert.equal(f.store.readChat('group:101').messages[0].text, 'B original history');
});

test('runtime state uses non-enumerable CAS identity and stale writers cannot lose new messages', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); const first = f.store.readChat('group:101'), stale = f.store.readChat('group:101');
  assert.deepEqual(Object.keys(first).sort(), ['chatKey', 'messages', 'nextLocalId']); assert.equal(first.archiveId, 'a-a'); assert.equal(first.revision, 1);
  first.messages.push(message(first.nextLocalId++, 'winner')); f.store.writeChat(first); assert.equal(first.revision, 2);
  stale.messages.push(message(stale.nextLocalId++, 'loser')); assert.throws(() => f.store.writeChat(stale), { statusCode: 409 }); assert.equal(f.store.readChat('group:101').messages.at(-1).text, 'winner');
  assert.throws(() => f.store.writeChat({ ...first }), { statusCode: 409 });
});

test('a pinned explicit archive can be saved after selection changes without writing into the new persona', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); const pinned = f.store.readChat('group:101', 'a-a'); f.store.select('group:101', 'a-b');
  pinned.messages.push(message(pinned.nextLocalId++, 'late successful delivery for A')); f.store.writeChat(pinned);
  assert.equal(f.store.readChat('group:101').messages.length, 1); assert.equal(f.store.readChat('group:101', 'a-a').messages.length, 2);
});

test('reimport is idempotent and never overwrites runtime additions or a changed active selection', t => {
  const f = fixture(t), source = bundle(); f.store.importBundle(source, { dryRun: false }); append(f.store, 'group:101', 'runtime append'); f.store.select('group:101', 'a-b');
  const result = f.store.importBundle(source, { dryRun: false }); assert.equal(result.archivesAdded, 0); assert.equal(result.archivesUpdated, 0); assert.equal(result.messagesAdded, 0);
  assert.equal(f.store.readChat('group:101', 'a-a').messages.at(-1).text, 'runtime append'); assert.equal(f.store.active('group:101').archiveId, 'a-b');
});

test('strict-prefix incremental imports remap source message ids and preserve intervening runtime entries', t => {
  const f = fixture(t), source = bundle(); f.store.importBundle(source, { dryRun: false }); append(f.store, 'group:101', 'runtime id two');
  source.archives[0].messages.push(message(2, 'source id two')); source.archives[0].transcript.push({ kind: 'legacy-event', raw: { sourceSequence: 2 } }); source.archives[0].lastUsedAt = 3;
  const result = f.store.importBundle(source, { dryRun: false }); assert.equal(result.archivesUpdated, 1); assert.equal(result.messagesAdded, 1);
  const state = f.store.readChat('group:101'); assert.deepEqual(state.messages.map(row => [row.id, row.text]), [[1, 'fixture archive message'], [2, 'runtime id two'], [3, 'source id two']]); assert.equal(state.nextLocalId, 4);
  assert.equal(f.store.importBundle(source, { dryRun: false }).messagesAdded, 0); assert.deepEqual(f.store.transcript('group:101'), source.archives[0].transcript);
  const db = new DatabaseSync(f.file, { readOnly: true }); try { assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM archive_imports WHERE kind='archive' AND item_id='a-a'").get().payload_json).messages.at(-1).id, 2); } finally { db.close(); }
});

test('incremental source imports can add fresh archives and selections without clearing existing runtime choices', t => {
  const f = fixture(t), source = bundle(); f.store.importBundle(source, { dryRun: false }); f.store.select('group:101', 'a-b');
  source.archives.push({ ...source.archives[0], id: 'new-archive', chatKey: 'group:202', messages: [] }); source.selected.push({ chatKey: 'group:202', archiveId: 'new-archive' });
  const result = f.store.importBundle(source, { dryRun: false }); assert.equal(result.archivesAdded, 1); assert.equal(result.selectionsAdded, 1); assert.equal(f.store.active('group:101').archiveId, 'a-b'); assert.equal(f.store.active('group:202').archiveId, 'new-archive');
});

test('edited or truncated source histories and incompatible identities reject the complete import', t => {
  const f = fixture(t), original = bundle(); f.store.importBundle(original, { dryRun: false });
  for (const change of [source => source.archives[0].messages[0].text = 'rewritten', source => source.archives[0].messages = [], source => source.archives[0].transcript = [], source => source.archives[0].personaId = 'p-b', source => source.personas[0].content = 'overwritten', source => source.selected[0].archiveId = 'a-b']) {
    const source = structuredClone(original); change(source); source.archives.push({ ...original.archives[0], id: 'must-not-be-inserted', messages: [] }); assert.throws(() => f.store.importBundle(source, { dryRun: false }), { statusCode: 409 }); assert.equal(f.store.list().length, 3);
  }
});

test('different sources may reference identical ids but cannot silently replace their contents', t => {
  const f = fixture(t), original = bundle(); f.store.importBundle(original, { dryRun: false }); const alias = structuredClone(original); alias.sourceId = 'fixture-second-source';
  assert.equal(f.store.importBundle(alias, { dryRun: false }).archivesAdded, 0); alias.archives[0].messages[0].text = 'source collision'; assert.throws(() => f.store.importBundle(alias, { dryRun: false }), { statusCode: 409 });
  assert.equal(f.store.readChat('group:101').messages[0].text, 'fixture archive message');
});

test('same archive ids in different bots remain isolated and cross-bot state cannot be written', t => {
  const f = fixture(t), second = f.create('secondary'); f.store.importBundle(bundle(), { dryRun: false }); second.importBundle(bundle(), { dryRun: false });
  append(f.store, 'group:101', 'primary only'); assert.equal(second.readChat('group:101').messages.length, 1);
  assert.throws(() => second.writeChat(f.store.readChat('group:101')), { statusCode: 409 }); assert.equal(second.readChat('group:101').messages.length, 1);
  second.select('group:101', 'a-b'); assert.equal(f.store.active('group:101').archiveId, 'a-a');
});

test('bundle shape, versions, duplicate ids, references and native message invariants fail closed', t => {
  const f = fixture(t);
  const edits = [source => source.version = 2, source => source.extra = true, source => source.archives[0].messages[0].read = false,
    source => source.archives[0].messages.push(message(1)), source => source.archives[0].chatKey = 'group:01', source => source.archives[0].personaId = 'missing-persona',
    source => source.selected[0].archiveId = 'private-a', source => source.personas.push(source.personas[0]), source => source.archives[0].messages[0].ts = NaN,
    source => source.archives[0].messages[0].injected = true, source => source.archives[0].transcript.push(() => {}), source => source.coverage = []];
  for (const edit of edits) { const source = bundle(); edit(source); assert.throws(() => f.store.importBundle(source)); assert.equal(fs.existsSync(f.file), false); }
  const accessor = bundle(); Object.defineProperty(accessor.coverage, 'unsafe', { enumerable: true, get() { throw Error('accessor should never execute'); } }); assert.throws(() => validateArchiveBundle(accessor), /访问器/);
});

test('native optional flags and structured reply/media survive import and runtime recalled updates', t => {
  const f = fixture(t), source = bundle(), entry = source.archives[0].messages[0]; Object.assign(entry, { isPoke: false, atMe: true, atNames: ['@fixture'], recalled: false, reply: { sender: 'fixture', text: 'quoted' }, media: [{ kind: 'image', url: 'https://example.invalid/image.png', raw: { fixture: true } }] });
  f.store.importBundle(source, { dryRun: false }); const state = f.store.readChat('group:101'); assert.deepEqual(state.messages[0], entry); state.messages[0].recalled = true; state.messages[0].read = false; f.store.writeChat(state); assert.equal(f.store.readChat('group:101').messages[0].recalled, true);
});

test('SQL failure after staged source/persona writes rolls back the entire import', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); const db = new DatabaseSync(f.file); db.exec("CREATE TRIGGER fixture_abort BEFORE INSERT ON conversation_archives WHEN NEW.id='fail-archive' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;"); db.close();
  const source = bundle(); source.sourceId = 'fixture-rollback-source'; source.personas = [{ id: 'new-persona', name: 'new', content: 'new', version: 1, history: [] }]; source.archives = [{ ...source.archives[0], id: 'fail-archive', personaId: 'new-persona' }]; source.selected = [];
  assert.throws(() => f.store.importBundle(source, { dryRun: false }), /fixture rollback/); assert.equal(f.store.personas().some(row => row.id === 'new-persona'), false);
  const check = new DatabaseSync(f.file, { readOnly: true }); try { assert.equal(check.prepare('SELECT COUNT(*) n FROM archive_sources WHERE id=?').get('fixture-rollback-source').n, 0); } finally { check.close(); }
});

test('unknown SQLite versions and corrupt JSON never fall back to a fresh empty archive', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); const state = f.store.readChat('group:101');
  const db = new DatabaseSync(f.file); db.prepare('UPDATE conversation_archives SET chat_json=? WHERE id=?').run('{broken', 'a-a'); db.close();
  assert.throws(() => f.store.writeChat(state), { statusCode: 503 }); assert.throws(() => f.store.readChat('group:101'), { statusCode: 503 });
  const check = new DatabaseSync(f.file, { readOnly: true }); try { assert.equal(check.prepare('SELECT chat_json FROM conversation_archives WHERE id=?').get('a-a').chat_json, '{broken'); } finally { check.close(); }
  f.store.close(); const changed = new DatabaseSync(f.file); changed.exec('PRAGMA user_version=99'); changed.close(); const hash = digest(f.file); assert.throws(() => f.create().importBundle(bundle()), { statusCode: 503 }); assert.equal(digest(f.file), hash);
});

test('hot reads do not scan unrelated inert history while a write still refuses corrupt storage', t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); const valid = f.store.readChat('group:101');
  const db = new DatabaseSync(f.file); db.prepare('UPDATE conversation_archives SET transcript_json=? WHERE id=?').run('{broken fixture', 'private-a'); db.close();
  assert.equal(f.store.active('group:101').archiveId, 'a-a'); assert.equal(f.store.readChat('group:101').messages[0].text, 'fixture archive message');
  assert.throws(() => f.store.writeChat(valid), { statusCode: 503 }); assert.throws(() => f.store.transcript('private:101'), { statusCode: 503 });
});

test('large passive archives retain data and use bounded hot reads', t => {
  const f = fixture(t), source = bundle();
  source.archives[0].messages = Array.from({ length: 10000 }, (_, index) => message(index + 1, 'fixture history ' + index + ' ' + 'x'.repeat(100)));
  source.archives[0].transcript = Array.from({ length: 4000 }, (_, index) => ({ kind: 'legacy-event', raw: { index, text: 'fixture passive transcript ' + 'x'.repeat(180) } }));
  f.store.importBundle(source, { dryRun: false });
  const activeStart = performance.now(); for (let index = 0; index < 30; index++) assert.equal(f.store.active('group:101').archiveId, 'a-a'); const activeMs = performance.now() - activeStart;
  const readStart = performance.now(); for (let index = 0; index < 30; index++) assert.equal(f.store.readChat('group:101').messages.length, 10000); const readMs = performance.now() - readStart;
  assert.deepEqual(f.store.transcript('group:101'), source.archives[0].transcript);
  t.diagnostic(`fixture archive bytes=${Buffer.byteLength(JSON.stringify(source))}; active 30=${activeMs.toFixed(1)}ms; readChat 30=${readMs.toFixed(1)}ms`);
});

test('schema two migrates counts atomically without modifying retained history and dry-run remains read only',t=>{
  const f=fixture(t);f.store.importBundle(bundle(),{dryRun:false});f.store.close();
  let db=new DatabaseSync(f.file);db.exec('DROP INDEX archive_chat_lookup; ALTER TABLE conversation_archives DROP COLUMN message_count; ALTER TABLE conversation_archives DROP COLUMN transcript_count; PRAGMA user_version=2');
  const before=db.prepare('SELECT id,chat_json,transcript_json FROM conversation_archives ORDER BY id').all();db.close();
  const store=f.create(),original=digest(f.file);assert.equal(store.importBundle(bundle()).dryRun,true);assert.equal(digest(f.file),original);
  store.upgradeSchema();db=new DatabaseSync(f.file,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);assert.deepEqual(db.prepare('SELECT id,chat_json,transcript_json FROM conversation_archives ORDER BY id').all(),before);db.close();
  assert.equal(store.list('group:101')[0].messageCount,1);
});

test('metadata and validated repeated writes do not reload unrelated passive transcripts; external corruption invalidates validation',t=>{
  const f=fixture(t);f.store.importBundle(bundle(),{dryRun:false});append(f.store,'group:101','first validated write');
  const load=f.store._load.bind(f.store);let loads=0;f.store._load=(...args)=>{loads++;return load(...args);};
  assert.equal(f.store.listChats().length,2);assert.equal(f.store.list('group:101',{limit:1,offset:1}).length,1);
  append(f.store,'group:101','second targeted write');assert.equal(loads,0);
  const db=new DatabaseSync(f.file);db.prepare('UPDATE conversation_archives SET transcript_json=? WHERE id=?').run('{broken fixture','private-a');db.close();
  assert.throws(()=>append(f.store,'group:101','must not commit'),e=>e.statusCode===503);assert.equal(loads,1);
  assert.equal(f.store.readChat('group:101').messages.at(-1).text,'second targeted write');
});

test('unrelated existing databases and invalid file identities are never repurposed', t => {
  const f = fixture(t); const db = new DatabaseSync(f.file); db.exec('CREATE TABLE fixture_private(value TEXT)'); db.close(); const hash = digest(f.file);
  assert.throws(() => f.store.importBundle(bundle(), { dryRun: false }), { statusCode: 503 }); assert.equal(digest(f.file), hash);
  assert.throws(() => new ConversationArchives({ file: 'relative.sqlite' }), { statusCode: 400 });
});

test('two independent processes reading one revision cannot overwrite each other', async t => {
  const f = fixture(t); f.store.importBundle(bundle(), { dryRun: false }); f.store.close();
  const workers = [0, 1].map(i => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cas-worker', f.file, String(i)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', diagnostic = '', readyResolve; const ready = new Promise(resolve => readyResolve = resolve);
    const done = new Promise((resolve, reject) => { child.stdout.on('data', part => { output += part; if (output.includes('\n')) readyResolve(); }); child.stderr.on('data', part => diagnostic += part); child.on('error', reject); child.on('exit', code => { if (code) return reject(Error(diagnostic)); try { resolve(JSON.parse(output.trim().split('\n').at(-1)).accepted); } catch (error) { reject(error); } }); });
    return { child, ready, done };
  });
  await Promise.all(workers.map(worker => worker.ready)); for (const worker of workers) worker.child.stdin.end('commit');
  assert.equal((await Promise.all(workers.map(worker => worker.done))).filter(Boolean).length, 1); const reopened = f.create(); assert.equal(reopened.readChat('group:101').messages.length, 2); assert.equal(reopened.readChat('group:101').revision, 2);
});
