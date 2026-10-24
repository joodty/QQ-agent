import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createBotPreferences, BOT_PREFERENCE_DEFAULTS, BOT_PREFERENCE_FIELDS, validateBotPreferenceOverrides } from '../src/bot-preferences.js';

if (!isMainThread) {
  const actor = { id: 'worker', role: 'user' };
  const service = createBotPreferences({ file: workerData.file, auth: { verifyPrincipal: () => actor }, canManageBot: () => true });
  try {
    await service.update(actor, { botId: 'contended', expectedVersion: 0, overrides: { replyPercent: workerData.percent } });
    parentPort.postMessage('saved');
  } catch (error) { parentPort.postMessage(error.code); }
  finally { service.close(); }
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-bot-preferences-'));
  test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

  function fixture(t, { onChanged } = {}) {
    const dir = fs.mkdtempSync(path.join(temp, 'case-')), file = path.join(dir, 'preferences.sqlite');
    const accounts = new Map([
      ['alice', { id: 'alice', role: 'user', passwordVersion: 1 }],
      ['bob', { id: 'bob', role: 'user', passwordVersion: 1 }],
      ['admin', { id: 'admin', role: 'admin', passwordVersion: 1 }]
    ]);
    const sessions = new Map([...accounts].map(([id]) => [id + '-session', id]));
    const principals = Object.fromEntries([...accounts].map(([id, account]) => [id, { ...account, sessionHash: id + '-session' }]));
    const owners = new Map([['bot-a', 'alice'], ['bot-b', 'bob'], ['bot-admin', 'admin']]);
    const primary = new Set(['admin']);
    const auth = { verifyPrincipal(principal) {
      const account = accounts.get(sessions.get(principal?.sessionHash));
      if (!account || account.disabled || account.id !== principal.id || account.passwordVersion !== principal.passwordVersion) throw Error('invalid session');
      return { ...account, sessionHash: principal.sessionHash, apiKey: 'fixture-never-public', internalToken: 'fixture-internal-only' };
    } };
    const canManageBot = (p, botId) => botId === 'primary' ? primary.has(p.id) : owners.get(botId) === p.id;
    const services = [];
    function open(options = {}) { const service = createBotPreferences({ file, auth, canManageBot, onChanged, ...options }); services.push(service); return service; }
    const service = open();
    t.after(() => { for (const item of services) item.close(); });
    return { file, accounts, sessions, owners, primary, auth, principals, service, open, ...principals };
  }

  test('verified ownership applies equally to administrators and users; primary authority is explicit', async t => {
    const f = fixture(t);
    assert.equal(f.service.overview(f.alice, { botId: 'bot-a' }).version, 0);
    assert.throws(() => f.service.overview(f.bob, { botId: 'bot-a' }), { code: 'BOT_PREFERENCES_ACCESS_DENIED' });
    assert.throws(() => f.service.overview(f.admin, { botId: 'bot-a' }), { code: 'BOT_PREFERENCES_ACCESS_DENIED' });
    await assert.rejects(f.service.update(f.admin, { botId: 'bot-a', expectedVersion: 0, overrides: {} }), { statusCode: 403 });
    assert.throws(() => f.service.overview(f.alice, { botId: 'primary' }), { statusCode: 403 });
    f.primary.add('alice');
    assert.equal(f.service.overview(f.alice, { botId: 'primary' }).botId, 'primary');
    f.primary.delete('alice');
    assert.throws(() => f.service.overview(f.alice, { botId: 'primary' }), { statusCode: 403 });
  });

  test('all APIs verify current sessions and ignore submitted role or stale permission snapshots', async t => {
    const f = fixture(t);
    const forged = { ...f.alice, role: 'admin' };
    await assert.rejects(f.service.updateDefaults(forged, { expectedVersion: 1, defaults: { replyPercent: 20 } }), { statusCode: 403 });
    assert.throws(() => f.service.overview({ ...f.alice, id: 'bob' }, { botId: 'bot-b' }), { statusCode: 401 });
    f.accounts.get('admin').role = 'user';
    await assert.rejects(f.service.updateDefaults(f.admin, { expectedVersion: 1, defaults: {} }), { statusCode: 403 });
    f.sessions.delete('alice-session');
    assert.throws(() => f.service.overview(f.alice, { botId: 'bot-a' }), { statusCode: 401 });
    assert.throws(() => f.service.defaults(f.alice), { statusCode: 401 });
    await assert.rejects(f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: {} }), { statusCode: 401 });
  });

  test('overrides replace explicitly, null and omission restore inheritance, and restart retains preferences', async t => {
    const f = fixture(t);
    const initial = f.service.overview(f.alice, { botId: 'bot-a' });
    assert.deepEqual(initial.effective, BOT_PREFERENCE_DEFAULTS);
    assert.deepEqual(Object.keys(initial.overrides), BOT_PREFERENCE_FIELDS);
    assert.ok(Object.values(initial.overrides).every(value => value === null));
    await f.service.updateDefaults(f.admin, { expectedVersion: 1, defaults: { replyPercent: 22, contextMessages: 80, speed: .5 } });
    const saved = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { replyPercent: 60, groupIds: ['12345', '12345', '23456'], privateIds: ['34567'], personaText: '独立机器人测试人设', speed: -.25 } });
    assert.equal(saved.effective.replyPercent, 60);
    assert.equal(saved.effective.contextMessages, 80);
    assert.deepEqual(saved.effective.groupIds, ['12345', '23456']);
    await f.service.updateDefaults(f.admin, { expectedVersion: 2, defaults: { replyPercent: 33, speed: 1 } });
    assert.equal(f.service.overview(f.alice, { botId: 'bot-a' }).effective.replyPercent, 60);
    const inherited = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 1, overrides: { replyPercent: null } });
    assert.equal(inherited.effective.replyPercent, 33);
    assert.equal(inherited.effective.speed, 1);
    assert.deepEqual(inherited.effective.groupIds, []);
    assert.equal(inherited.overrides.personaText, null);
    const reopened = f.open();
    assert.deepEqual(reopened.overview(f.alice, { botId: 'bot-a' }), inherited);
    assert.equal(f.service.defaults(f.alice).version, 3);
  });

  test('mention-only remains distinct from zero probability and does not silently rewrite saved probability', async t => {
    const f = fixture(t);
    const only = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { mentionOnly: true, replyPercent: 90 } });
    assert.equal(only.effective.mentionOnly, true);
    assert.equal(only.effective.replyPercent, 90);
    const zero = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 1, overrides: { mentionOnly: false, replyPercent: 0 } });
    assert.equal(zero.effective.mentionOnly, false);
    assert.equal(zero.effective.replyPercent, 0);
  });

  test('worker boundary validator requires concrete known fields and optionally requires complete settings', () => {
    assert.deepEqual(validateBotPreferenceOverrides(BOT_PREFERENCE_DEFAULTS, { complete: true }), BOT_PREFERENCE_DEFAULTS);
    assert.deepEqual(validateBotPreferenceOverrides({ groupIds: ['12345', '12345'], speed: .75 }), { speed: .75, groupIds: ['12345'] });
    assert.throws(() => validateBotPreferenceOverrides({ enabled: true }, { complete: true }), { code: 'BOT_PREFERENCES_INVALID' });
    assert.throws(() => validateBotPreferenceOverrides({ replyPercent: null }), { code: 'BOT_PREFERENCES_INVALID' });
    assert.throws(() => validateBotPreferenceOverrides({ endpoint: 'https://fixture.test' }), { code: 'BOT_PREFERENCES_INVALID' });
  });

  test('invalid fields, coercions, unsafe speech styles and platform chat lists never change storage', async t => {
    const f = fixture(t);
    const invalid = [
      { apiKey: 'fixture-key' }, { enabled: 1 }, { mentionOnly: 'true' }, { replyPercent: -1 }, { replyPercent: 101 },
      { replyPercent: .5 }, { replyPercent: '10' }, { autoVoicePercent: NaN }, { contextMessages: 501 },
      { contextMessages: -1 }, { speed: -1.01 }, { speed: 2.01 }, { speed: .123 }, { volume: -5.01 },
      { volume: 5.01 }, { volume: Infinity }, { voiceType: 999999999 }, { voiceType: '101001' },
      { privateIds: [12345] }, { groupIds: ['012345'] }, { groupIds: ['group:12345'] },
      { groupIds: Array(101).fill('12345') }, { personaText: '' }, { personaText: ' '.repeat(20) },
      { personaText: 'x'.repeat(12001) }, { personaText: '\u0000' }, { enabled: undefined }
    ];
    for (const overrides of invalid) await assert.rejects(f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides }), { code: 'BOT_PREFERENCES_INVALID' });
    await assert.rejects(f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: {}, owner: 'alice' }), { statusCode: 400 });
    for (const defaults of [{ groupIds: ['12345'] }, { privateIds: ['23456'] }, { replyPercent: null }, { token: 'fixture' }])
      await assert.rejects(f.service.updateDefaults(f.admin, { expectedVersion: 1, defaults }), { statusCode: 400 });
    assert.equal(f.service.overview(f.alice, { botId: 'bot-a' }).version, 0);
    assert.equal(f.service.defaults(f.admin).version, 1);
    const valid = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { contextMessages: 0, speed: -1, volume: 5, voiceType: 101004 } });
    assert.equal(valid.effective.speed, -1);
    assert.equal(valid.effective.volume, 5);
  });

  test('same-file instances serialize callbacks and CAS rejects concurrent stale writes', async t => {
    const started = gate(), resume = gate(), events = [];
    const f = fixture(t, { onChanged: async event => { events.push(event); if (event.version === 1) { started.resolve(); await resume.promise; } event.assertCurrent(); } });
    const peer = f.open();
    const first = f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { replyPercent: 31 } });
    await started.promise;
    assert.equal(peer.overview(f.alice, { botId: 'bot-a' }).application.status, 'pending');
    const stale = peer.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { replyPercent: 32 } });
    const latest = peer.update(f.alice, { botId: 'bot-a', expectedVersion: 1, overrides: { replyPercent: 33 } });
    resume.resolve();
    const results = await Promise.allSettled([first, stale, latest]);
    assert.deepEqual(results.map(row => row.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(results[1].reason.code, 'BOT_PREFERENCES_VERSION_CONFLICT');
    assert.deepEqual(events.map(row => row.version), [1, 2]);
    assert.equal(f.service.overview(f.alice, { botId: 'bot-a' }).effective.replyPercent, 33);
  });

  test('SQLite CAS admits one independent worker writer for the same bot version', async t => {
    const f = fixture(t);
    const results = await Promise.all([10, 20, 30, 40].map(percent => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { file: f.file, percent } });
      let result;
      worker.on('message', value => { result = value; }); worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve(result) : reject(Error('Worker failed: ' + code)));
    })));
    assert.equal(results.filter(row => row === 'saved').length, 1);
    assert.equal(results.filter(row => row === 'BOT_PREFERENCES_VERSION_CONFLICT').length, 3);
    assert.equal(f.service.runtimePolicy('contended').version, 1);
  });

  test('queued work rechecks revoked ownership before persistence', async t => {
    const started = gate(), resume = gate();
    const f = fixture(t, { onChanged: async event => { if (event.botId === 'bot-admin') { started.resolve(); await resume.promise; } } });
    const running = f.service.update(f.admin, { botId: 'bot-admin', expectedVersion: 0, overrides: {} });
    await started.promise;
    const queued = f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { replyPercent: 70 } });
    f.owners.delete('bot-a'); resume.resolve();
    await running;
    await assert.rejects(queued, { statusCode: 403 });
    assert.equal(f.service.runtimePolicy('bot-a').version, 0);
  });

  test('application failures retain saved preferences, hide internal errors and can be retried', async t => {
    let reject = true;
    const f = fixture(t, { onChanged(event) { assert.equal(event.effective.replyPercent, 58); if (reject) throw Error('fixture-runtime-secret'); } });
    const saved = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { replyPercent: 58 } });
    assert.equal(saved.version, 1);
    assert.equal(saved.application.status, 'failed');
    assert.equal(JSON.stringify(saved).includes('fixture-runtime-secret'), false);
    reject = false;
    const retry = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 1, overrides: { replyPercent: 58 } });
    assert.equal(retry.application.status, 'applied');
    const unconnected = f.open({ onChanged: undefined });
    const none = await unconnected.update(f.bob, { botId: 'bot-b', expectedVersion: 0, overrides: {} });
    assert.equal(none.application.status, 'not_connected');
  });

  test('an explicit offline result saves preferences as not connected, while other negative acknowledgements fail', async t => {
    let acknowledgement = { status: 'not_connected', applied: false };
    const f = fixture(t, { onChanged: () => acknowledgement });
    const offline = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { replyPercent: 81 } });
    assert.equal(offline.effective.replyPercent, 81);
    assert.equal(offline.application.status, 'not_connected');
    assert.equal(f.open().overview(f.alice, { botId: 'bot-a' }).application.status, 'not_connected');
    acknowledgement = false;
    const failure = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 1, overrides: { replyPercent: 82 } });
    assert.equal(failure.application.status, 'failed');
    acknowledgement = { applied: true };
    const connected = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 2, overrides: { replyPercent: 83 } });
    assert.equal(connected.application.status, 'applied');
  });

  test('defaults apply each registered bot separately and report partial failure without leaking overrides', async t => {
    const events = [];
    const f = fixture(t, { onChanged(event) { events.push(event); if (event.botId === 'bot-b') return { applied: false }; event.assertCurrent(); } });
    f.service.runtimePolicy('bot-a'); f.service.runtimePolicy('bot-b');
    await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: { personaText: 'Private fixture persona', replyPercent: 66 } });
    events.length = 0;
    const saved = await f.service.updateDefaults(f.admin, { expectedVersion: 1, defaults: { replyPercent: 27 } });
    assert.equal(saved.application.status, 'partial');
    assert.deepEqual(saved.application.bots, [{ botId: 'bot-a', status: 'applied' }, { botId: 'bot-b', status: 'failed' }, { botId: 'primary', status: 'applied' }]);
    assert.equal(f.service.runtimePolicy('bot-a').effective.replyPercent, 66);
    assert.equal(f.service.runtimePolicy('bot-b').effective.replyPercent, 27);
    assert.equal(f.service.runtimePolicy('bot-b').application.status, 'failed');
    assert.equal(JSON.stringify(saved).includes('Private fixture persona'), false);
    assert.equal(events.every(row => row.reason === 'defaults' && row.defaultsVersion === 2), true);
    await assert.rejects(f.service.updateDefaults(f.admin, { expectedVersion: 1, defaults: {} }), { statusCode: 409 });
  });

  test('runtime callbacks can guard against revocation that occurs while awaiting dependencies', async t => {
    const started = gate(), resume = gate(); let applied = false;
    const f = fixture(t, { onChanged: async event => { started.resolve(); await resume.promise; event.assertCurrent(); applied = true; } });
    const operation = f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: {} });
    await started.promise;
    f.sessions.delete('alice-session'); resume.resolve();
    await assert.rejects(operation, { statusCode: 401 });
    assert.equal(applied, false);
    assert.equal(f.service.runtimePolicy('bot-a').application.status, 'failed');
  });

  test('public projection contains only preference fields and returned objects cannot mutate persistence', async t => {
    const f = fixture(t);
    const view = f.service.overview(f.alice, { botId: 'bot-a' });
    assert.equal(JSON.stringify(view).includes('fixture-never-public'), false);
    assert.equal(JSON.stringify(view).includes('internalToken'), false);
    view.effective.replyPercent = 100; view.platformDefaults.groupIds.push('12345'); view.overrides.groupIds = ['23456'];
    assert.equal(f.service.overview(f.alice, { botId: 'bot-a' }).effective.replyPercent, 10);
    assert.deepEqual(f.service.defaults(f.alice).defaults.groupIds, []);
    const input = { replyPercent: 52, groupIds: ['12345'] };
    const operation = f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: input });
    input.replyPercent = 100; input.groupIds.push('23456');
    const saved = await operation;
    assert.equal(saved.effective.replyPercent, 52); assert.deepEqual(saved.effective.groupIds, ['12345']);
  });

  test('trusted startup seeds preserve primary history once, never run callbacks and never overwrite existing versions', async t => {
    let events = 0;
    const f = fixture(t, { onChanged: () => { events++; } });
    const seeded = f.open({ initialBotOverrides: { primary: { groupIds: ['12345'], privateIds: ['23456'], personaText: 'Preserved fixture persona', replyPercent: 47 } } });
    const original = seeded.overview(f.admin, { botId: 'primary' });
    assert.equal(original.version, 1);
    assert.equal(original.effective.replyPercent, 47);
    assert.deepEqual(original.effective.groupIds, ['12345']);
    assert.equal(events, 0);
    assert.equal(seeded.overview(f.alice, { botId: 'bot-a' }).version, 0);
    const again = f.open({ initialBotOverrides: { primary: { replyPercent: 98, groupIds: ['34567'] } } });
    assert.deepEqual(again.overview(f.admin, { botId: 'primary' }), original);
    const changed = await again.update(f.admin, { botId: 'primary', expectedVersion: 1, overrides: { replyPercent: 55 } });
    const afterUpdate = f.open({ initialBotOverrides: { primary: { replyPercent: 2 } } });
    assert.deepEqual(afterUpdate.overview(f.admin, { botId: 'primary' }), changed);
    assert.throws(() => f.open({ initialBotOverrides: { primary: { secret: 'fixture' } } }), { code: 'BOT_PREFERENCES_INVALID' });
    assert.equal(events, 1);
  });

  test('change events provide a freshly verified internal principal without projecting it publicly', async t => {
    let received;
    const f = fixture(t, { onChanged: event => { received = event.principal; } });
    const view = await f.service.update(f.alice, { botId: 'bot-a', expectedVersion: 0, overrides: {} });
    assert.equal(received.id, 'alice'); assert.equal(received.sessionHash, f.alice.sessionHash);
    assert.equal(received.apiKey, 'fixture-never-public');
    assert.equal(Object.hasOwn(view, 'principal'), false);
    assert.equal(JSON.stringify(view).includes('fixture-never-public'), false);
    await f.service.updateDefaults(f.admin, { expectedVersion: 1, defaults: {} });
    assert.equal(received.id, 'admin');
  });

  test('foreign databases and corrupt stored values are rejected without overwriting original data', async t => {
    const f = fixture(t), foreign = path.join(path.dirname(f.file), 'foreign.sqlite');
    const db = new DatabaseSync(foreign); db.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('fixture-original');"); db.close();
    assert.throws(() => f.open({ file: foreign }), { code: 'BOT_PREFERENCES_STORAGE_INVALID' });
    const check = new DatabaseSync(foreign); assert.equal(check.prepare('SELECT value FROM preserved').get().value, 'fixture-original'); check.close();
    const corrupt = new DatabaseSync(f.file); corrupt.prepare("UPDATE bot_preferences_meta SET value_json=? WHERE name='defaults'").run(JSON.stringify({ ...BOT_PREFERENCE_DEFAULTS, enabled: 'true' })); corrupt.close();
    assert.throws(() => f.open(), { code: 'BOT_PREFERENCES_STORAGE_INVALID' });
  });
}
