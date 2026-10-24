import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHostedBots } from '../src/hosted-bots.js';
import { createHostedLoginClient, publicHostedLoginState } from '../src/hosted-login-client.js';
import { createHostedQQAgentService, createDockerQQAgentRuntime, findHostedQQLoginWindow, hostedLoginWindowPng } from '../scripts/hosted-qqagent-service.mjs';

const id = index => index.toString(16).padStart(32, '0');
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-hosted-test-'));
  let clock = Date.now(); const live = new Map(), resources = new Set(), sessions = new Map();
  const principal = index => {
    const actor = { kind: 'session', id: id(index), sessionHash: crypto.createHash('sha256').update('fixture-session-' + index).digest('hex'), passwordVersion: 1, role: index === 1 ? 'admin' : 'user' };
    sessions.set(actor.sessionHash, actor); return actor;
  };
  const admin = principal(1), alice = principal(2), bob = principal(3);
  let failStart = false, failStop = false, gate = null, starts = 0, stops = 0;
  const runtime = {
    capacity: async () => options.capacity !== false,
    async start(row) { starts++; resources.add(row.request_id); await gate; if (failStart) throw Error('fixture start failure'); },
    async inspect(row) { return live.get(row.request_id) || { qrImage: 'data:image/png;base64,AAAA' }; },
    async stop(row) { stops++; if (failStop) throw Error('fixture stop failure'); resources.delete(row.request_id); },
    async refresh(row) { live.delete(row.request_id); }
  };
  const config = { root: path.join(root, 'runtime'), secret: crypto.randomBytes(32).toString('base64url'), port: 17000, basePort: 20000, maxBots: options.maxBots || 2, cooldownMs: 0, refreshCooldownMs: 0 };
  const service = createHostedQQAgentService(config, { runtime, now: () => clock });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + service.server.address().port;
  const client = createHostedLoginClient({ baseUrl, secret: config.secret });
  const store = { verifiedSession: hash => sessions.get(hash) || null };
  const file = path.join(root, 'platform-hosted.sqlite');
  let manager = createHostedBots({ file, platformStore: store, loginClient: client, now: () => clock, cooldownMs: options.cooldownMs ?? 0, maxBots: config.maxBots, onReady: options.onReady });
  t.after(async () => { manager.close(); await service.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-hosted-test-'))); fs.rmSync(root, { force: true, recursive: true }); });
  return { root, service, client, baseUrl, config, runtime, live, resources, alice, bob, admin, sessions, store, file,
    get manager() { return manager; }, get starts() { return starts; }, get stops() { return stops; },
    advance(ms) { clock += ms; }, failStart(value) { failStart = value; }, failStop(value) { failStop = value; }, gate(value) { gate = value; },
    reopen() { manager.close(); manager = createHostedBots({ file, platformStore: store, loginClient: client, now: () => clock, cooldownMs: options.cooldownMs ?? 0, maxBots: config.maxBots }); }
  };
}

test('ordinary account applies and scans its own isolated QQ; no connection secret crosses public boundary', async t => {
  const f = await fixture(t), request = f.manager.create(f.alice, { expectedQQ: '10001', name: 'Fixture bot' });
  const start = await f.manager.start(f.alice, { requestId: request.id, version: request.version });
  assert.equal(start.login.state, 'waiting_scan'); assert.ok(start.login.qrImage);
  assert.equal(f.manager.overview(f.bob).requests.length, 0);
  assert.equal(f.manager.overview(f.admin).requests.length, 0);
  await assert.rejects(f.manager.status(f.bob, { requestId: request.id }), { statusCode: 404 });
  await assert.rejects(f.manager.status(f.admin, { requestId: request.id }), { statusCode: 404 });
  f.live.set(request.id, { actualQQ: '10001', online: true, agentReady: false, qrImage: 'data:image/png;base64,AAAA' });
  const connecting = await f.manager.status(f.alice, { requestId: request.id });
  assert.deepEqual(connecting.login, { state: 'connecting' });
  f.live.set(request.id, { actualQQ: '10001', online: true, agentReady: true });
  const ready = await f.manager.status(f.alice, { requestId: request.id });
  assert.equal(ready.request.status, 'ready');
  const connection = await f.manager.connection(request.id);
  assert.equal(connection.origin, 'http://127.0.0.1:20002'); assert.ok(connection.machineToken);
  const output = JSON.stringify([start, ready, f.manager.overview(f.alice)]);
  assert.equal(output.includes(connection.machineToken), false); assert.equal(/machine_token|machineToken|onebotToken/.test(output), false);
});

test('browser cannot select owner, slot, bot identity or URL; sessions are freshly checked', async t => {
  const f = await fixture(t);
  assert.throws(() => f.manager.create(f.alice, { expectedQQ: '10001', ownerUserId: f.bob.id }), { statusCode: 400 });
  assert.throws(() => f.manager.create({ ...f.alice, kind: 'token' }, { expectedQQ: '10001' }), { statusCode: 401 });
  const row = f.manager.create(f.alice, { expectedQQ: '10001' });
  for (const bad of [{ slot: 1 }, { expectedQQ: '10002' }, { botId: 'primary' }, { url: 'http://example.invalid/' }]) await assert.rejects(f.manager.start(f.alice, { requestId: row.id, ...bad }), { statusCode: 400 });
  f.sessions.delete(f.alice.sessionHash);
  await assert.rejects(f.manager.start(f.alice, { requestId: row.id }), { statusCode: 401 });
});

test('SQL atomically reserves bounded slots and excludes duplicate owner and QQ', async t => {
  const f = await fixture(t, { maxBots: 1 });
  const row = f.manager.create(f.alice, { expectedQQ: '10001' });
  assert.throws(() => f.manager.create(f.alice, { expectedQQ: '10002' }), { statusCode: 409 });
  assert.throws(() => f.manager.create(f.bob, { expectedQQ: '10001' }), { statusCode: 409 });
  assert.throws(() => f.manager.create(f.bob, { expectedQQ: '10002' }), { statusCode: 429 });
  assert.equal((await f.manager.cancel(f.alice, { requestId: row.id })).request.slot, null);
  assert.equal(f.manager.create(f.bob, { expectedQQ: '10002' }).slot, 0);
});

test('an unstarted application cannot retain a scarce slot indefinitely', async t => {
  const f = await fixture(t, { maxBots: 1 });
  const old = f.manager.create(f.alice, { expectedQQ: '10001' }); f.advance(600001);
  assert.equal(f.manager.overview(f.alice).requests[0].status, 'stopped');
  assert.equal(f.manager.create(f.bob, { expectedQQ: '10002' }).slot, 0);
  await assert.rejects(f.manager.start(f.alice, { requestId: old.id }), { statusCode: 429 });
  assert.equal(f.resources.size, 0);
});

test('manager non-reentrant lease survives a second SQL connection and stale version', async t => {
  const f = await fixture(t), row = f.manager.create(f.alice, { expectedQQ: '10001' });
  let release; f.gate(new Promise(resolve => { release = resolve; }));
  const pending = f.manager.start(f.alice, { requestId: row.id });
  const second = createHostedBots({ file: f.file, platformStore: f.store, loginClient: f.client, cooldownMs: 0, maxBots: 2 });
  await assert.rejects(second.status(f.alice, { requestId: row.id }), { statusCode: 409 });
  release(); await pending;
  second.close();
  await assert.rejects(f.manager.refresh(f.alice, { requestId: row.id, version: row.version }), { statusCode: 409 });
  assert.equal(f.starts, 1);
});

test('wrong QQ stops both resources and never exposes a frame or ready identity', async t => {
  const f = await fixture(t), row = f.manager.create(f.alice, { expectedQQ: '10001' });
  await f.manager.start(f.alice, { requestId: row.id });
  f.live.set(row.id, { actualQQ: '10002', online: true, agentReady: true, qrImage: 'data:image/png;base64,AAAA' });
  assert.deepEqual((await f.manager.status(f.alice, { requestId: row.id })).login, { state: 'mismatch' });
  assert.equal(f.resources.has(row.id), false);
  await assert.rejects(f.manager.connection(row.id), { statusCode: 409 });
  await assert.rejects(f.manager.start(f.alice, { requestId: row.id }), { statusCode: 409 });
  await f.manager.cancel(f.alice, { requestId: row.id });
  assert.equal(f.manager.overview(f.alice).capacity.available, 2);
});

test('late session revocation compensates a started runtime before returning QR', async t => {
  const f = await fixture(t), row = f.manager.create(f.alice, { expectedQQ: '10001' });
  let release; f.gate(new Promise(resolve => { release = resolve; }));
  const pending = f.manager.start(f.alice, { requestId: row.id });
  f.sessions.delete(f.alice.sessionHash); release();
  await assert.rejects(pending, { statusCode: 401 });
  assert.equal(f.resources.size, 0);
});

test('failed start with uncertain cleanup retains capacity; retry cancel repairs it', async t => {
  const f = await fixture(t, { maxBots: 1 }); f.failStart(true); f.failStop(true);
  const row = f.manager.create(f.alice, { expectedQQ: '10001' });
  await assert.rejects(f.manager.start(f.alice, { requestId: row.id }), { statusCode: 503 });
  assert.equal(f.manager.overview(f.alice).requests[0].status, 'cleanup_pending');
  assert.equal(f.manager.overview(f.alice).capacity.available, 0);
  f.failStart(false); f.failStop(false);
  assert.equal((await f.manager.cancel(f.alice, { requestId: row.id })).request.status, 'stopped');
  assert.equal(f.resources.size, 0); assert.equal(f.manager.overview(f.alice).capacity.available, 1);
});

test('ready callback failure pauses runtime and returns no success', async t => {
  const f = await fixture(t, { onReady: async () => { throw Error('fixture configuration failure'); } });
  const row = f.manager.create(f.alice, { expectedQQ: '10001' });
  await f.manager.start(f.alice, { requestId: row.id }); f.live.set(row.id, { actualQQ: '10001', online: true, agentReady: true });
  await assert.rejects(f.manager.status(f.alice, { requestId: row.id }), /configuration failure/);
  assert.equal(f.resources.size, 0); assert.equal(f.manager.overview(f.alice).requests[0].status, 'stopped');
});

test('reopen retains ownership, expected QQ and versions; offline cannot remain ready', async t => {
  const f = await fixture(t), row = f.manager.create(f.alice, { expectedQQ: '10001' });
  await f.manager.start(f.alice, { requestId: row.id }); f.live.set(row.id, { actualQQ: '10001', online: true, agentReady: true });
  await f.manager.status(f.alice, { requestId: row.id }); f.reopen();
  assert.equal(f.manager.overview(f.alice).requests[0].expectedQQ, '10001');
  await f.service.recover(); f.live.set(row.id, {});
  assert.equal((await f.manager.status(f.alice, { requestId: row.id })).login.state, 'connecting');
});

test('QR expiration, fixed refresh, reconnect, idle janitor and cooldown have explicit states', async t => {
  const f = await fixture(t, { cooldownMs: 30000 }), row = f.manager.create(f.alice, { expectedQQ: '10001' });
  await f.manager.start(f.alice, { requestId: row.id });
  await assert.rejects(f.manager.reconnect(f.alice, { requestId: row.id }), { statusCode: 429 });
  f.advance(121000); assert.equal((await f.manager.status(f.alice, { requestId: row.id })).login.state, 'expired');
  assert.equal((await f.manager.refresh(f.alice, { requestId: row.id })).login.state, 'waiting_scan');
  assert.equal((await f.manager.reconnect(f.alice, { requestId: row.id })).login.state, 'waiting_scan');
  f.advance(601000); await f.service.sweep();
  assert.equal((await f.manager.status(f.alice, { requestId: row.id })).request.slot, null);
});

test('private HTTP endpoint rejects wrong secret, browser headers and oversized bodies', async t => {
  const f = await fixture(t), input = { requestId: id(9), ownerUserId: f.alice.id, expectedQQ: '10001', slot: 0, version: 1 };
  for (const headers of [{}, { 'x-hosted-service-secret': f.config.secret, origin: 'https://example.invalid' }, { 'x-hosted-service-secret': f.config.secret, cookie: 'fixture=x' }]) {
    const response = await fetch(f.baseUrl + '/v1/start', { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(response.status, 403);
  }
  const response = await fetch(f.baseUrl + '/v1/start', { method: 'POST', headers: { 'x-hosted-service-secret': f.config.secret }, body: JSON.stringify({ ...input, junk: 'a'.repeat(5000) }) });
  assert.equal(response.status, 400); assert.equal(f.starts, 0);
  assert.throws(() => createHostedLoginClient({ baseUrl: 'http://example.invalid', secret: f.config.secret }));
});

test('broker binds immutable owner/QQ/slot and refuses stale operations after restart', async t => {
  const f = await fixture(t), input = { requestId: id(9), ownerUserId: f.alice.id, expectedQQ: '10001', slot: 0, version: 4 };
  await f.service.operation('start', input);
  for (const edit of [{ ownerUserId: f.bob.id }, { expectedQQ: '10002' }, { slot: 1 }, { version: 3 }]) await assert.rejects(f.service.operation('status', { ...input, ...edit }), { code: 'CONFLICT' });
  await f.service.recover(); assert.equal(f.resources.size, 1);
  assert.equal((await f.service.operation('status', input)).login.state, 'waiting_scan');
});

test('backend capacity and invalid format preserve existing data', async t => {
  const f = await fixture(t, { capacity: false }), row = f.manager.create(f.alice, { expectedQQ: '10001' });
  await assert.rejects(f.manager.start(f.alice, { requestId: row.id }), { statusCode: 503 });
  assert.equal(f.resources.size, 0);
  const bad = path.join(f.root, 'unrelated.sqlite'), db = new DatabaseSync(bad); db.exec('CREATE TABLE retained (id TEXT)'); db.close();
  assert.throws(() => createHostedBots({ file: bad, platformStore: f.store }), /禁止覆盖/);
  const inspect = new DatabaseSync(bad); assert.ok(inspect.prepare("SELECT name FROM sqlite_schema WHERE name='retained'").get()); inspect.close();
});

test('login state uses a strict public allowlist; window parser rejects main windows', () => {
  const value = publicHostedLoginState({ state: 'ready', machineToken: 'fixture-secret', onebotToken: 'fixture-secret', qrImage: 'data:image/png;base64,AAAA' });
  assert.deepEqual(value, { state: 'ready' });
  assert.throws(() => publicHostedLoginState({ state: 'invented-success' }));
  assert.equal(findHostedQQLoginWindow('0x123 "QQ": ("qq" "QQ") 1024x768+0+0 +0+0'), null);
  assert.deepEqual(findHostedQQLoginWindow('0x123 "QQ": ("qq" "QQ") 320x460+0+0 +20+30'), { id: '0x123', x: 20, y: 30, width: 320, height: 460 });
  assert.throws(() => hostedLoginWindowPng(Buffer.alloc(104), { x: 0, y: 0, width: 320, height: 460 }));
});

test('broker SQL survives a real close/reopen and completes uncertain cancellation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-hosted-restart-'));
  const config = { root, secret: crypto.randomBytes(32).toString('base64url'), port: 17000, basePort: 20000, maxBots: 1, cooldownMs: 0 };
  let failStop = false, stopped = false;
  const runtime = { start: async () => {}, inspect: async () => ({ actualQQ: '10001', online: true, agentReady: true }), stop: async () => { if (failStop) throw Error('fixture stop'); stopped = true; } };
  let broker = createHostedQQAgentService(config, { runtime });
  t.after(async () => { await broker.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-hosted-restart-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { requestId: id(9), ownerUserId: id(2), expectedQQ: '10001', slot: 0, version: 1 };
  const first = await broker.operation('start', input); await broker.close();
  broker = createHostedQQAgentService(config, { runtime }); await broker.recover();
  const next = await broker.operation('status', { ...input, version: 2 });
  assert.equal(next.login.state, 'ready'); assert.equal(next.connection.machineToken, first.connection.machineToken);
  failStop = true; await assert.rejects(broker.operation('cancel', { ...input, version: 3 }), /fixture stop/); await broker.close();
  failStop = false; broker = createHostedQQAgentService(config, { runtime }); await broker.recover();
  assert.equal(stopped, true); assert.equal((await broker.operation('status', { ...input, version: 4 })).login.state, 'stopped');
});

test('private model template refuses identity/data injection and requires bounded instance total', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-hosted-template-')), file = path.join(root, 'template.json');
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-hosted-template-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { root, modelTemplateFile: file, maxBotDailyLimitCny: 3, maxChatDailyLimitCny: 1.5 };
  const valid = { api: { apiKey: 'fixture-approved-only' }, productionBudget: { enabled: true, defaultDailyLimitCny: 1.5, totalDailyLimitCny: 3, funding: { 'group:10001': { enabled: true } }, initialSpent: { fixture: 9 } } };
  for (const edit of [value => value.platform = { file: '/fixture/source/accounts.sqlite' }, value => value.productionBudget.totalDailyLimitCny = 0,
    value => delete value.productionBudget.totalDailyLimitCny, value => value.productionBudget.totalDailyLimitCny = 4, value => value.productionBudget.defaultDailyLimitCny = 2,
    value => value.speech = { credentialFile: 'relative.json', timeoutMs: 10000 }]) {
    const next = structuredClone(valid); edit(next); fs.writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
    assert.throws(() => createDockerQQAgentRuntime(config));
  }
  fs.writeFileSync(file, JSON.stringify(valid), { mode: 0o600 });
  assert.ok(createDockerQQAgentRuntime(config));
});

test('Docker login capture emits only a visible fixed login window and rechecks account identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-hosted-frame-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-hosted-frame-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const frame = Buffer.alloc(104 + 320 * 460 * 4);
  for (const [index, value] of [[0, 104], [1, 7], [2, 2], [4, 320], [5, 460], [7, 0], [11, 32], [12, 1280], [14, 0xff0000], [15, 0xff00], [16, 0xff]]) frame.writeUInt32BE(value, index * 4);
  let identityCalls = 0, becameWrongAccount = false, visible = true; const commands = [];
  const runtime = createDockerQQAgentRuntime({ root, dockerBin: '/fixture/docker', dockerSocket: '/fixture/docker.sock', basePort: 20000 }, {
    exec: async (_file, args) => {
      commands.push(args);
      if (args.includes('xwd')) return { stdout: frame };
      return { stdout: args.includes('-tree') ? '0x123 "QQ": ("qq" "QQ") 320x460+0+0 +20+30' : 'Map State: ' + (visible ? 'IsViewable' : 'IsUnMapped') };
    },
    fetchImpl: async () => { identityCalls++; return new Response(JSON.stringify({ status: 'ok', data: becameWrongAccount && identityCalls % 2 === 0 ? { user_id: '10002' } : {} })); }
  });
  const row = { request_id: id(9), expected_qq: '10001', slot: 0, qr_at: Date.now(), onebot_token: 'fixture-only' };
  const image = await runtime.inspect(row); assert.ok(image.qrImage.startsWith('data:image/png;base64,'));
  assert.ok(commands.filter(args => args.includes('xwd')).every(args => args.includes('-id') && !args.includes('-root')));
  becameWrongAccount = true; identityCalls = 0;
  assert.deepEqual(await runtime.inspect(row), { actualQQ: '10002', online: false, agentReady: false });
  becameWrongAccount = false; visible = false;
  assert.deepEqual(await runtime.inspect(row), {});
});
