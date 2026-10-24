import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHostedBots } from '../src/hosted-bots.js';
import { createHostedLoginClient, publicHostedLoginState } from '../src/hosted-login-client.js';
import { createHostedQQAgentService, createDockerQQAgentRuntime, validateHostedQQAgentConfig, findHostedQQLoginWindow, hostedLoginWindowPng } from '../scripts/hosted-qqagent-service.mjs';

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
    async start(row) { starts++; resources.add(row.request_id); await gate; if(options.isolationMismatch)throw Object.assign(Error('fixture isolation mismatch'),{code:'ISOLATION_MISMATCH'}); if (failStart) throw Error('fixture start failure'); },
    async inspect(row) { if(options.isolationInspect)throw Object.assign(Error('fixture Agent isolation mismatch'),{code:'ISOLATION_MISMATCH'}); return live.get(row.request_id) || { qrImage: 'data:image/png;base64,AAAA' }; },
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
  fs.writeFileSync(file, JSON.stringify({...valid,platform:{resourcesOnly:true}}), {mode:0o600});
  assert.ok(createDockerQQAgentRuntime(config));
  fs.writeFileSync(file, JSON.stringify({...valid,platform:{resourcesOnly:true,enabled:true}}), {mode:0o600});
  assert.throws(()=>createDockerQQAgentRuntime(config));
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
      if(args[2]==='inspect')return {stdout:JSON.stringify([{Name:'/qqagent-host-'+id(9),Config:{Labels:{'qq-agent.request':id(9),'qq-agent.owner':id(2)}},HostConfig:{NetworkMode:'none',Memory:640*1024**2,MemorySwap:640*1024**2,OomScoreAdj:1000},State:{Running:true}}])};
      if (args.includes('xwd')) return { stdout: frame };
      return { stdout: args.includes('-tree') ? '0x123 "QQ": ("qq" "QQ") 320x460+0+0 +20+30' : 'Map State: ' + (visible ? 'IsViewable' : 'IsUnMapped') };
    },
    fetchImpl: async () => { identityCalls++; return new Response(JSON.stringify({ status: 'ok', data: becameWrongAccount && identityCalls % 2 === 0 ? { user_id: '10002' } : {} })); }
  });
  const row = { request_id: id(9), owner_user_id:id(2), expected_qq: '10001', slot: 0, qr_at: Date.now(), onebot_token: 'fixture-only' };
  const image = await runtime.inspect(row); assert.ok(image.qrImage.startsWith('data:image/png;base64,'));
  assert.ok(commands.filter(args => args.includes('xwd')).every(args => args.includes('-id') && !args.includes('-root')));
  becameWrongAccount = true; identityCalls = 0;
  assert.deepEqual(await runtime.inspect(row), { actualQQ: '10002', online: false, agentReady: false });
  becameWrongAccount = false; visible = false;
  assert.deepEqual(await runtime.inspect(row), {});
});

test('hosted isolation rejects ancestor slices, cgroup injection and invalid swap without executing Docker', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-hosted-isolation-validation-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const base={root,secret:crypto.randomBytes(32).toString('base64url'),port:17000,basePort:20000,maxBots:1};
  for(const containerCgroupParent of ['system.slice','user.slice','machine.slice','root.slice','/qqhosted.slice',
    'system/qqhosted.slice','qq-hosted.slice','qqhosted.slice/child','qqhosted.slice --oom-kill-disable','qqhosted.slice\n','QQHosted.slice','',null]){
    assert.throws(()=>validateHostedQQAgentConfig({...base,containerCgroupParent},{injectedRuntime:true}),/independent top-level slice/);
    assert.throws(()=>createDockerQQAgentRuntime({...base,containerCgroupParent}),/independent top-level slice/);
  }
  for(const qqSwapMb of [-1,513,.5,'256',null,NaN,Infinity]){
    assert.throws(()=>validateHostedQQAgentConfig({...base,qqSwapMb},{injectedRuntime:true}),/swap must be an integer/);
    assert.throws(()=>createDockerQQAgentRuntime({...base,qqSwapMb}),/swap must be an integer/);
  }
  for(const qqMemory of ['640m;touch /tmp/fixture','-1m','640.5m','unbounded',Number.MAX_SAFE_INTEGER+'g'])
    assert.throws(()=>createDockerQQAgentRuntime({...base,qqMemory,qqSwapMb:256}),/memory/);
  for(const qqSwapMb of [0,1,256,512])
    assert.ok(validateHostedQQAgentConfig({...base,containerCgroupParent:'qqhosted.slice',qqSwapMb},{injectedRuntime:true}));
});

async function capturedContainerArguments(t,overrides={},runtimeOptions={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-hosted-isolation-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const commands=[],stop=Error('fixture-stops-before-any-container-can-run');
  const row={request_id:id(90),owner_user_id:id(2),expected_qq:'10001',slot:0,identity_index:0,onebot_token:'fixture-onebot',machine_token:'fixture-machine'};
  const runtime=createDockerQQAgentRuntime({root,dockerBin:'/fixture/docker',dockerSocket:'/fixture/docker.sock',basePort:20000,
    uidBase:process.getuid?.()??10000,gidBase:process.getgid?.()??10000,codeRoot:'/fixture/release',startScript:'/fixture/start.sh',
    image:'fixture-qq@sha256:'+'a'.repeat(64),agentImage:'fixture-agent@sha256:'+'b'.repeat(64),...overrides},{
    availableMemoryKb:()=>8*1024*1024,
    exec:async(_file,args)=>{
      if(args[2]==='inspect'){
        if(args[3]==='qqagent-host-'+row.request_id&&commands.length){
          const memory=overrides.qqMemory==='1g'?1024:overrides.qqMemory==='800m'?800:640;
          return {stdout:JSON.stringify([{Name:'/qqagent-host-'+row.request_id,Config:{Labels:{'qq-agent.request':row.request_id,'qq-agent.owner':row.owner_user_id}},
            HostConfig:{NetworkMode:'none',CgroupParent:overrides.containerCgroupParent||'',Memory:memory*1024**2,MemorySwap:(memory+(overrides.qqSwapMb||0))*1024**2,OomScoreAdj:1000},State:{Running:true}}])};
        }
        throw Object.assign(Error('fixture missing container'),{stderr:'Error: No such container'});
      }
      if(args[2]==='run'){commands.push(args);throw stop;}
      assert.fail('Unexpected fake Docker command: '+args[2]);
    },
    spawnImpl:()=>assert.fail('Fixture never starts a network helper or container'),
    fetchImpl:async url=>{
      assert.ok(String(url).startsWith('http://127.0.0.1:20000/'));
      return new Response(JSON.stringify({status:'ok',data:String(url).endsWith('/get_login_info')?{user_id:10001}:{online:true}}));
    },...runtimeOptions
  });
  await assert.rejects(runtime.start(row),error=>error===stop);
  await assert.rejects(runtime.inspect(row),error=>error===stop);
  assert.equal(commands.length,2);
  const argument=(args,flag)=>args[args.indexOf(flag)+1];
  const qq=commands.find(args=>argument(args,'--name')==='qqagent-host-'+row.request_id);
  const agent=commands.find(args=>argument(args,'--name')==='qqagent-host-'+row.request_id+'-agent');
  assert.ok(qq&&agent);
  return {qq,agent,argument};
}

test('both owned containers use a separate configured slice and maximum positive OOM score; QQ swap is total memory plus swap',async t=>{
  const {qq,agent,argument}=await capturedContainerArguments(t,{containerCgroupParent:'qqhosted.slice',qqMemory:'640m',qqSwapMb:256});
  for(const args of [qq,agent]){
    assert.equal(argument(args,'--cgroup-parent'),'qqhosted.slice');
    assert.equal(argument(args,'--oom-score-adj'),'1000');
    assert.equal(args.includes('--oom-kill-disable'),false);
    assert.equal(args.includes('--privileged'),false);
  }
  assert.equal(argument(qq,'--memory'),'640m');assert.equal(argument(qq,'--memory-swap'),'896m');
  assert.equal(argument(agent,'--memory'),'192m');assert.equal(argument(agent,'--memory-swap'),'192m');
});

test('omitted isolation flags preserve previous memory/swap limits and add no cgroup ancestry',async t=>{
  const {qq,agent,argument}=await capturedContainerArguments(t);
  for(const args of [qq,agent]){
    assert.equal(args.includes('--cgroup-parent'),false);
    assert.equal(argument(args,'--oom-score-adj'),'1000');
  }
  assert.equal(argument(qq,'--memory'),'640m');assert.equal(argument(qq,'--memory-swap'),'640m');
  assert.equal(argument(agent,'--memory'),'192m');assert.equal(argument(agent,'--memory-swap'),'192m');
});

test('QQ swap arithmetic respects a configured GiB limit while explicit zero leaves its literal Docker limit intact',async t=>{
  const matched=await capturedContainerArguments(t,{qqMemory:'800m',qqSwapMb:256});
  assert.equal(matched.argument(matched.qq,'--memory-swap'),'1056m');
  const raised=await capturedContainerArguments(t,{qqMemory:'1g',qqSwapMb:512});
  assert.equal(raised.argument(raised.qq,'--memory-swap'),'1536m');
  const unchanged=await capturedContainerArguments(t,{qqMemory:'1g',qqSwapMb:0});
  assert.equal(unchanged.argument(unchanged.qq,'--memory-swap'),'1g');
});

test('explicit host memory gates require nonnegative safe KiB integers; zero disables only the selected precheck',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-hosted-memory-gate-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const base={root,secret:crypto.randomBytes(32).toString('base64url'),port:17000,basePort:20000,maxBots:1};
  for(const field of ['minAvailableMemoryKb','minAgentAvailableMemoryKb']){
    for(const value of [-1,.5,'0','1',null,NaN,Infinity,2**40+1,Number.MAX_SAFE_INTEGER]){
      const config={...base,[field]:value};
      assert.throws(()=>validateHostedQQAgentConfig(config,{injectedRuntime:true}),/nonnegative safe integer/);
      assert.throws(()=>createDockerQQAgentRuntime(config),/nonnegative safe integer/);
      assert.throws(()=>createHostedQQAgentService(config,{runtime:{}}),/nonnegative safe integer/);
    }
    for(const value of [0,1,1024,1120000,2**40])assert.ok(validateHostedQQAgentConfig({...base,[field]:value},{injectedRuntime:true}));
  }
  let available=122;
  const runtime=createDockerQQAgentRuntime({...base,minAvailableMemoryKb:123,minAgentAvailableMemoryKb:1},{availableMemoryKb:()=>available});
  assert.equal(await runtime.capacity(),false);available=123;assert.equal(await runtime.capacity(),true);
});

test('zero host prechecks allow capacity and both synthetic starts even when meminfo is unavailable',async t=>{
  let reads=0;
  const noMemoryProbe=()=>{reads++;throw Error('fixture meminfo intentionally unavailable');};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-hosted-zero-gate-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const disabled=createDockerQQAgentRuntime({root,minAvailableMemoryKb:0,minAgentAvailableMemoryKb:0},{availableMemoryKb:noMemoryProbe});
  assert.equal(await disabled.capacity(),true);assert.equal(reads,0);
  const {qq,agent}=await capturedContainerArguments(t,{minAvailableMemoryKb:0,minAgentAvailableMemoryKb:0},{availableMemoryKb:noMemoryProbe});
  assert.ok(qq&&agent);assert.equal(reads,0,'Explicit zero never reads host memory for either container');
  const defaults=createDockerQQAgentRuntime({root},{availableMemoryKb:noMemoryProbe});
  assert.equal(await defaults.capacity(),false);assert.equal(reads,1,'Omission preserves the default host gate');
});

function existingContainerFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-hosted-existing-isolation-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const row={request_id:id(91),owner_user_id:id(2),expected_qq:'10001',slot:0,identity_index:0,onebot_token:'fixture-onebot',machine_token:'fixture-machine'};
  const qqName='qqagent-host-'+row.request_id,agentName=qqName+'-agent',commands=[];
  const make=(agent=false)=>({Name:'/'+(agent?agentName:qqName),Config:{Labels:{'qq-agent.request':row.request_id,'qq-agent.owner':row.owner_user_id}},
    HostConfig:{NetworkMode:agent?'container:'+qqName:'none',CgroupParent:'qqhosted.slice',Memory:(agent?192:800)*1024**2,MemorySwap:(agent?192:1056)*1024**2,OomScoreAdj:1000},State:{Running:true}});
  const containers=new Map([[qqName,make()],[agentName,make(true)]]);
  const runtime=createDockerQQAgentRuntime({root,dockerBin:'/fixture/docker',dockerSocket:'/fixture/docker.sock',basePort:20000,
    containerCgroupParent:'qqhosted.slice',qqMemory:'800m',qqSwapMb:256},{
    availableMemoryKb:()=>8*1024*1024,
    exec:async(_file,args)=>{
      commands.push(args);const action=args[2],name=args[3];
      if(action==='inspect'){
        if(!containers.has(name))throw Object.assign(Error('fixture missing'),{stderr:'No such container'});
        return {stdout:JSON.stringify([containers.get(name)])};
      }
      if(action==='start'){containers.get(name).State.Running=true;return {stdout:name};}
      if(action==='rm'){containers.delete(args.at(-1));return {stdout:''};}
      assert.fail('Existing container must never be recreated: '+action);
    },
    spawnImpl:()=>assert.fail('No host helper can be started by this fixture'),
    fetchImpl:async url=>new Response(JSON.stringify(String(url).endsWith('/api/hosted/identity')?
      {ok:true,botId:'hosted-'+row.request_id,expectedQQ:row.expected_qq,actualQQ:row.expected_qq,qqOnline:true,agentReady:true}:
      {status:'ok',data:String(url).endsWith('/get_login_info')?{user_id:10001}:{online:true}}))
  });
  return {root,row,qqName,agentName,containers,commands,runtime,make};
}

test('existing QQ/Agent HostConfig mismatches fail closed before restart, recreation or deletion',async t=>{
  const f=existingContainerFixture(t);
  for(const name of [f.qqName,f.agentName])for(const [field,bad] of [['CgroupParent','system.slice'],['Memory',0],['MemorySwap',-1],['OomScoreAdj',0]]){
    f.containers.set(f.qqName,f.make());f.containers.set(f.agentName,f.make(true));
    f.containers.get(name).HostConfig[field]=bad;
    f.commands.length=0;
    await assert.rejects(f.runtime.inspect(f.row),error=>error.code==='ISOLATION_MISMATCH'&&error.message.includes(field));
    if(name===f.qqName)await assert.rejects(f.runtime.start(f.row),{code:'ISOLATION_MISMATCH'});
    assert.equal(f.commands.some(args=>['run','start','rm'].includes(args[2])),false);
    assert.equal(f.containers.size,2);
  }
});

test('matching existing isolation is retained and a stopped matching Agent can resume without rebuilding or deleting data',async t=>{
  const f=existingContainerFixture(t),preserved=path.join(f.root,'preserved-login-state');fs.writeFileSync(preserved,'fixture-login-retained');
  assert.deepEqual(await f.runtime.inspect(f.row),{actualQQ:'10001',online:true,agentReady:true});
  assert.equal(f.commands.some(args=>['run','start','rm'].includes(args[2])),false);
  f.containers.get(f.agentName).State.Running=false;f.commands.length=0;
  assert.deepEqual(await f.runtime.inspect(f.row),{actualQQ:'10001',online:true,agentReady:true});
  assert.deepEqual(f.commands.filter(args=>args[2]==='start').map(args=>args[3]),[f.agentName]);
  assert.equal(f.commands.some(args=>['run','rm'].includes(args[2])),false);
  assert.equal(fs.readFileSync(preserved,'utf8'),'fixture-login-retained');
});

test('explicit cancellation can remove owned mismatching containers but preflights every label and preserves login data',async t=>{
  const f=existingContainerFixture(t),preserved=path.join(f.root,'preserved-login-state');fs.writeFileSync(preserved,'fixture-login-retained');
  f.containers.get(f.qqName).HostConfig.CgroupParent='system.slice';
  f.containers.get(f.agentName).Config.Labels['qq-agent.owner']=id(3);
  await assert.rejects(f.runtime.stop(f.row),{code:'CONFLICT'});
  assert.equal(f.commands.some(args=>args[2]==='rm'),false,'A foreign label blocks the whole cleanup before either removal');
  f.containers.get(f.agentName).Config.Labels['qq-agent.owner']=f.row.owner_user_id;
  await f.runtime.stop(f.row);
  assert.equal(f.containers.size,0);
  assert.deepEqual(f.commands.filter(args=>args[2]==='rm').map(args=>args.at(-1)),[f.agentName,f.qqName]);
  assert.equal(fs.readFileSync(preserved,'utf8'),'fixture-login-retained');
});

test('broker preserves a failed isolation reservation until explicit cancel, then supports a fresh reconnect',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-hosted-isolation-recovery-'));
  let mismatch=true,stops=0;
  const runtime={async start(){if(mismatch)throw Object.assign(Error('fixture HostConfig mismatch'),{code:'ISOLATION_MISMATCH'});},
    async inspect(){return {qrImage:'data:image/png;base64,AAAA'};},async stop(){stops++;},async capacity(){return true;}};
  const service=createHostedQQAgentService({root,secret:crypto.randomBytes(32).toString('base64url'),port:17000,basePort:20000,maxBots:1,cooldownMs:0},{runtime});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const input={requestId:id(92),ownerUserId:id(2),expectedQQ:'10001',slot:0,version:1};
  assert.equal((await service.operation('start',input)).login.state,'failed');
  assert.equal(stops,0);
  const db=new DatabaseSync(path.join(root,'hosted-runtime.sqlite'),{readOnly:true});
  assert.deepEqual({...db.prepare('SELECT state,reserved FROM runtime_instances').get()},{state:'failed',reserved:1});
  db.close();await service.recover();assert.equal(stops,0);
  assert.equal((await service.operation('status',input)).login.state,'failed');
  assert.equal((await service.operation('cancel',{...input,version:2})).login.state,'stopped');assert.equal(stops,1);
  mismatch=false;
  assert.equal((await service.operation('reconnect',{...input,version:3})).login.state,'waiting_scan');
});

test('real broker client and manager retain isolation-failed instances instead of compensating them with cancel',async t=>{
  const options={isolationMismatch:true},f=await fixture(t,options),row=f.manager.create(f.alice,{expectedQQ:'10001'});
  const failed=await f.manager.start(f.alice,{requestId:row.id,version:row.version});
  assert.equal(failed.login.state,'failed');assert.equal(failed.request.status,'failed');
  assert.equal(f.stops,0);assert.equal(f.resources.has(row.id),true);
  assert.equal(f.manager.overview(f.alice).capacity.available,1);
  await f.service.recover();assert.equal(f.stops,0);
  assert.equal((await f.manager.status(f.alice,{requestId:row.id})).login.state,'failed');
  assert.equal((await f.manager.cancel(f.alice,{requestId:row.id})).login.state,'stopped');
  assert.equal(f.stops,1);assert.equal(f.resources.has(row.id),false);
  options.isolationMismatch=false;
  assert.equal((await f.manager.reconnect(f.alice,{requestId:row.id})).login.state,'waiting_scan');
});

test('an Agent isolation failure discovered after QQ startup also returns failed without upstream cancellation',async t=>{
  const options={isolationInspect:true},f=await fixture(t,options),row=f.manager.create(f.alice,{expectedQQ:'10001'});
  assert.equal((await f.manager.start(f.alice,{requestId:row.id})).login.state,'failed');
  assert.equal(f.stops,0);assert.equal(f.resources.has(row.id),true);
  assert.equal((await f.manager.status(f.alice,{requestId:row.id})).login.state,'failed');
  assert.equal(f.stops,0);
  await f.manager.cancel(f.alice,{requestId:row.id});assert.equal(f.stops,1);
});
