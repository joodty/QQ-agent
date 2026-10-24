// Real gateway/app and independent worker processes; every QQ, model, speech
// and broker runtime is synthetic. No production environment is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeDataDir, writeConfig, freePort, listen, waitFor, sleep, readBody, createMockOneBotHttp, createMockOneBotWs, createMockLLM } from './_harness.mjs';
import { createHostedLoginClient } from '../src/hosted-login-client.js';
import { createHostedQQAgentService } from '../scripts/hosted-qqagent-service.mjs';
import { BOT_PREFERENCE_DEFAULTS } from '../src/bot-preferences.js';

const MODEL_ORIGIN = 'https://hosted-model.example.invalid';
const FIXTURE_MODEL = 'fixture-hosted-model';
const credential = { format: 'qq-agent-tencent-speech-credential', version: 1, secretId: 'fixture-hosted-speech-id', secretKey: 'fixture-hosted-speech-key' };
const closeServer = async server => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); };
function syntheticConfig({ obPort, wsPort, appPort, token, platform = false, publicOrigin, expectedQQ = '10001' }) {
  return {
    platform: { enabled: platform, ...(publicOrigin ? { publicOrigin } : {}) },
    api: { baseUrl: MODEL_ORIGIN + '/v1', apiKey: 'fixture-isolated-model-key', model: FIXTURE_MODEL, vision: false, maxRounds: 3, timeoutMs: 2000 },
    snowluma: { autoLaunch: false, dir: '', wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${obPort}`, accessToken: '' },
    server: { port: appPort, token }, allow: { groups: platform ? ['456'] : [], private: platform ? ['999'] : [] }, deny: { groups: [], private: [] }, allowAllWhenEmpty: false,
    persona: { botName: 'HostedFixture', roleText: platform ? 'PRIMARY_EXISTING_PERSONA' : 'UNCONFIGURED_WORKER_PERSONA' },
    store: { contextSliderPos: 5, historyCount: 17, keywords: [], ...(platform ? { replyByChat: { 'group:456': { version: 1, replyPercent: 73 } } } : {}) }, wakeDelayMs: 30, drainDelayMs: 40, maxConcurrentRuns: 1,
    send: { minGapMs: 1, maxGapMs: 1, byLengthMs: 0, maxPerMinute: 1000, maxPerHour: 10000, dedupeWindowMs: 0 },
    proactive: { enabled: false }, chatActive: { enabled: false }, memory: { consolidateEnabled: false }, sticker: { enabled: false, collectEnabled: false }, webSearch: { enabled: false }, extensions: { hotReload: false },
    productionBudget: { enabled: true, endpoint: MODEL_ORIGIN + '/v1', model: FIXTURE_MODEL,
      prices: { inputCnyPerMillion: 2, cacheHitCnyPerMillion: 0.04, outputCnyPerMillion: 8, reasoningIncluded: true },
      totalDailyLimitCny: 3, defaultDailyLimitCny: 1.5, overrides: {}, initialSpent: {}, funding: platform ? { 'group:456': { mode: 'platform', enabled: true } } : {}, outputCap: 512, imageTokensPerImage: 1024 },
    hostedFundingLimits: { speechDailyLimitCny: 0.3, speechPlatformDailyLimitCny: 0.3, speechCooldownMs: 1000 },
    speech: { timeoutMs: 1000 }, hostedLeaseUntil: 0
  };
}
function jsonRequest(port, { method = 'GET', route, body, cookie = '', origin, token, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: {
      ...(origin ? { host: new URL(origin).host, origin } : {}), ...(cookie ? { cookie } : {}),
      ...(token ? { 'x-console-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders
    } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, data, text, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function workerMain() {
  const nativeFetch = globalThis.fetch; let random = 0.1, speechCalls = 0, lastSpeech = null;
  const wave = Buffer.alloc(46); wave.write('RIFF'); wave.writeUInt32LE(38, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(2, 40);
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === MODEL_ORIGIN) return nativeFetch('http://127.0.0.1:' + process.env.HOSTED_FIXTURE_LLM_PORT + url.pathname, init);
    if (url.hostname === 'tts.tencentcloudapi.com') { speechCalls++; const body = JSON.parse(init.body); lastSpeech = { voiceType: body.VoiceType, speed: body.Speed, volume: body.Volume }; return Promise.resolve(new Response(JSON.stringify({ Response: { Audio: wave.toString('base64'), SessionId: body.SessionId, RequestId: 'fixture-hosted-tts' } }))); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(Error('Hosted worker fixture rejects external networking'));
    return nativeFetch(input, init);
  };
  Math.random = () => random;
  const { createApp } = await import('../src/app.js');
  const app = createApp({ log() {}, speechCredentials: () => credential });
  const port = await app.start();
  await waitFor(() => app.onebot.connected && app.onebot.selfId === process.env.QQ_AGENT_HOSTED_EXPECTED_QQ, 10000, 'worker mock identity');
  process.send({ type: 'ready', port });
  process.on('message', async message => {
    try {
      if (message.command === 'stop') { await app.stop(); (await import('../src/paid-call-guard.js')).closeProductionPaidCallGuard(); process.send({ id: message.id, ok: true }); process.exit(0); }
      if (message.command === 'random') random = message.value;
      if (message.command === 'self') app.onebot.selfInfo = { user_id: message.value, nickname: 'Fixture switched identity' };
      if (message.command === 'reconnect') { await app.onebot.reconnect(); await waitFor(() => app.onebot.connected && app.onebot.selfId === process.env.QQ_AGENT_HOSTED_EXPECTED_QQ, 5000, 'worker identity recovered'); }
      const cfg = app.getConfig();
      process.send({ id: message.id, ok: true, snapshot: { paused: app.orchestrator.paused, runningCount: app.orchestrator.runningChats.size, actualQQ: app.onebot.selfId, config: { botControls: cfg.botControls, allow: cfg.allow, persona: cfg.persona, hostedApplied: cfg.hostedApplied, hostedLeaseUntil: cfg.hostedLeaseUntil, productionBudget: { totalDailyLimitCny: cfg.productionBudget?.totalDailyLimitCny, funding: cfg.productionBudget?.funding } }, speech: app.speechService.runtimePolicy('group:456'), speechCalls, lastSpeech } });
    } catch (error) { process.send({ id: message.id, ok: false, error: String(error.stack || error) }); }
  });
}

if (process.argv.includes('--worker-fixture')) {
  await workerMain();
} else {
  test('hosted accounts traverse real app/gateway with isolated broker, preferences and restart', async t => {
    const root = makeDataDir('qq-agent-hosted-app-'), publicOrigin = 'https://hosted-workspace.example.test';
    const ob = createMockOneBotHttp(), ws = createMockOneBotWs(), llm = createMockLLM();
    const obPort = await listen(ob.server), wsPort = await ws.ready(), llmPort = await listen(llm.server);
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.origin === MODEL_ORIGIN) return nativeFetch('http://127.0.0.1:' + llmPort + url.pathname, init); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(Error('Hosted platform fixture rejects external networking')); return nativeFetch(input, init); };
    const workerToken = crypto.randomBytes(32).toString('base64url'), workerCalls = [];
    const worker = http.createServer(async (req, res) => {
      const body = await readBody(req); workerCalls.push({ route: req.url, body, token: req.headers['x-console-token'] });
      const ok = req.headers['x-console-token'] === workerToken && req.method === 'PUT' && ['/api/hosted/settings', '/api/hosted/lease'].includes(req.url);
      res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok }));
    });
    const workerPort = await listen(worker), brokerSecret = crypto.randomBytes(32).toString('base64url'), runtime = new Map(), resources = new Set();
    const broker = createHostedQQAgentService({ root: path.join(root, 'fake-broker'), secret: brokerSecret, port: 17000, basePort: workerPort - 2, maxBots: 2, cooldownMs: 0 }, {
      runtime: { capacity: async () => true, start: async row => { resources.add(row.request_id); }, inspect: async row => runtime.get(row.request_id) || { qrImage: 'data:image/png;base64,AAAA' }, stop: async row => { resources.delete(row.request_id); }, refresh: async () => {} }
    });
    await listen(broker.server);
    // Replace only the broker's internal machine token with our synthetic worker
    // token. Everything else traverses the actual authenticated HTTP client.
    const realClient = createHostedLoginClient({ baseUrl: 'http://127.0.0.1:' + broker.server.address().port, secret: brokerSecret });
    const loginClient = Object.fromEntries(['start', 'status', 'refresh', 'reconnect', 'cancel'].map(action => [action, async input => { const result = await realClient[action](input); if (result.connection) result.connection.machineToken = workerToken; return result; }]));
    const token = crypto.randomBytes(32).toString('base64url');
    writeConfig(root, syntheticConfig({ obPort, wsPort, appPort: await freePort(), token, platform: true, publicOrigin }));
    const { createApp } = await import('../src/app.js'), { createAdminGateway } = await import('../src/admin-gateway.js'), { closeProductionPaidCallGuard } = await import('../src/paid-call-guard.js');
    let app, gateway;
    async function boot() {
      app = createApp({ log() {}, hostedOptions: { loginClient, maxBots: 2, reconcileMs: 1000 } });
      const port = await app.start(); await waitFor(() => app.onebot.connected && app.onebot.selfId === '888', 10000, 'primary fake QQ identity');
      gateway = createAdminGateway({ publicOrigin, platformFile: path.join(root, 'platform.sqlite'), targetOrigin: 'http://127.0.0.1:' + port, consoleToken: token }); await gateway.listen(await freePort());
    }
    async function stop() { await gateway?.close(); gateway = null; if (app) { const closed = new Promise(resolve => app.server.once('close', resolve)); await app.stop(); await closed; app = null; } closeProductionPaidCallGuard(); }
    t.after(async () => { await stop(); await broker.close(); await closeServer(worker); await ws.close(); await closeServer(ob.server); await closeServer(llm.server); globalThis.fetch = nativeFetch; assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-hosted-app-'))); fs.rmSync(root, { recursive: true, force: true }); });
    await boot(); await app.platformAuth.bootstrap({ username: 'fixture_admin', password: 'fixture-hosted-admin-pass' });
    const request = (method, route, body, cookie) => jsonRequest(gateway.server.address().port, { method, route, body, cookie, origin: publicOrigin });
    const ok = async (...args) => { const result = await request(...args); assert.equal(result.status, 200, result.text); return result; };
    const admin = (await ok('POST', '/api/auth/login', { username: 'fixture_admin', password: 'fixture-hosted-admin-pass' })).cookie;
    const alice = (await ok('POST', '/api/auth/register', { username: 'fixture_alice', password: 'fixture-hosted-alice-pass' })).cookie;
    const bob = (await ok('POST', '/api/auth/register', { username: 'fixture_bob', password: 'fixture-hosted-bob-pass' })).cookie;
    let aliceRequest, bobRequest, saved;
    await t.test('ordinary account creates its own request; unrelated accounts and admin cannot operate it', async () => {
      assert.equal((await request('GET', '/api/platform/hosted-bots')).status, 401);
      aliceRequest = (await ok('POST', '/api/platform/hosted-bots', { expectedQQ: '10001', name: 'Alice synthetic QQ' }, alice)).data.request;
      assert.equal((await ok('GET', '/api/platform/hosted-bots', undefined, bob)).data.requests.length, 0);
      assert.equal((await ok('GET', '/api/platform/hosted-bots', undefined, admin)).data.primaryBot.botId, 'primary');
      for (const cookie of [bob, admin]) {
        assert.equal((await request('POST', `/api/platform/hosted-bots/${aliceRequest.id}/start`, {}, cookie)).status, 404);
        assert.equal((await request('GET', '/api/platform/bot-preferences?botId=' + aliceRequest.botId, undefined, cookie)).status, 403);
        assert.equal((await request('PUT', '/api/platform/bot-preferences', { botId: aliceRequest.botId, expectedVersion: 0, overrides: { replyPercent: 90 } }, cookie)).status, 403);
      }
      assert.equal((await request('GET', '/api/platform/bot-preferences?botId=primary', undefined, alice)).status, 403);
      for (const cookie of [alice, admin]) assert.equal((await request('GET', '/api/hosted/identity', undefined, cookie)).status, 403);
    });
    await t.test('offline preferences persist, then the QR/identity workflow applies them to the verified worker', async () => {
      const initial = (await ok('GET', '/api/platform/bot-preferences?botId=' + aliceRequest.botId, undefined, alice)).data;
      saved = (await ok('PUT', '/api/platform/bot-preferences', { botId: aliceRequest.botId, expectedVersion: initial.version, overrides: { replyPercent: 20, mentionOnly: true, groupIds: ['456'], personaText: 'ALICE_OWN_PERSONA' } }, alice)).data;
      assert.equal(saved.application.status, 'not_connected'); assert.equal(workerCalls.length, 0);
      assert.equal((await ok('POST', `/api/platform/hosted-bots/${aliceRequest.id}/start`, {}, alice)).data.login.state, 'waiting_scan');
      runtime.set(aliceRequest.id, { actualQQ: '10001', online: true, agentReady: true });
      assert.equal((await ok('POST', `/api/platform/hosted-bots/${aliceRequest.id}/status`, {}, alice)).data.login.state, 'ready');
      const applied = workerCalls.find(row => row.route === '/api/hosted/settings');
      assert.equal(applied.body.effective.replyPercent, 20); assert.equal(applied.body.effective.mentionOnly, true); assert.deepEqual(applied.body.effective.groupIds, ['456']); assert.equal(applied.body.expectedQQ, '10001');
      assert.equal((await ok('GET', '/api/platform/bot-preferences?botId=' + aliceRequest.botId, undefined, alice)).data.application.status, 'applied');
    });
    await t.test('new defaults inherit only unset fields; own overrides and live primary behavior stay intact', async () => {
      const primary = app.hostedPlatform.preferences.runtimePolicy('primary').effective;
      const principal = app.platformAuth.authenticate(admin);
      app.speechService.updateSettings(principal, { chatKey: 'private:999', expectedVersion: 0, enabled: false, voiceType: 101055, speed: 1, volume: -3, autoVoicePercent: 35 });
      const primaryVoice = app.speechService.runtimePolicy('private:999').settings;
      const { storeConfigForChat } = await import('../src/config.js');
      const primaryReply = storeConfigForChat('group:456').replyPercent;
      const defaults = (await ok('GET', '/api/platform/bot-defaults', undefined, admin)).data;
      assert.equal((await request('PUT', '/api/platform/bot-defaults', { expectedVersion: defaults.version, defaults: { replyPercent: 55 } }, alice)).status, 403);
      await ok('PUT', '/api/platform/bot-defaults', { expectedVersion: defaults.version, defaults: { replyPercent: 55, contextMessages: 44, personaText: 'NEW_PLATFORM_DEFAULT_PERSONA' } }, admin);
      const current = (await ok('GET', '/api/platform/bot-preferences?botId=' + aliceRequest.botId, undefined, alice)).data;
      assert.equal(current.effective.replyPercent, 20); assert.equal(current.effective.contextMessages, 44); assert.equal(current.effective.personaText, 'ALICE_OWN_PERSONA');
      assert.deepEqual(app.hostedPlatform.preferences.runtimePolicy('primary').effective, primary);
      assert.deepEqual(app.getConfig().allow.groups, ['456']); assert.equal(app.getConfig().persona.roleText, 'PRIMARY_EXISTING_PERSONA'); assert.equal(app.getConfig().api.apiKey, 'fixture-isolated-model-key');
      assert.equal(storeConfigForChat('group:456').replyPercent, primaryReply, 'Updating new-bot defaults must preserve the primary chat reply policy');
      const afterVoice = app.speechService.runtimePolicy('private:999').settings;
      for (const field of ['enabled', 'voiceType', 'speed', 'volume', 'autoVoicePercent']) assert.deepEqual(afterVoice[field], primaryVoice[field], 'Updating new-bot defaults must preserve primary chat speech ' + field);
      const inherited = (await ok('PUT', '/api/platform/bot-preferences', { botId: aliceRequest.botId, expectedVersion: current.version, overrides: { mentionOnly: true, groupIds: ['456'] } }, alice)).data;
      assert.equal(inherited.effective.replyPercent, 55); assert.equal(inherited.effective.personaText, 'NEW_PLATFORM_DEFAULT_PERSONA'); saved = inherited;
    });
    await t.test('wrong scanned QQ is stopped and public payloads contain neither machine nor broker secret', async () => {
      bobRequest = (await ok('POST', '/api/platform/hosted-bots', { expectedQQ: '10002' }, bob)).data.request;
      await ok('POST', `/api/platform/hosted-bots/${bobRequest.id}/start`, {}, bob);
      runtime.set(bobRequest.id, { actualQQ: '10003', online: true, agentReady: true, qrImage: 'data:image/png;base64,AAAA' });
      const mismatch = (await ok('POST', `/api/platform/hosted-bots/${bobRequest.id}/status`, {}, bob)).data;
      assert.deepEqual(mismatch.login, { state: 'mismatch' }); assert.equal(resources.has(bobRequest.id), false);
      const publicResponses = [(await ok('GET', '/api/platform/hosted-bots', undefined, alice)).data, (await ok('GET', '/api/platform/bot-preferences?botId=' + aliceRequest.botId, undefined, alice)).data, mismatch];
      assert.equal(JSON.stringify(publicResponses).includes(workerToken), false); assert.equal(JSON.stringify(publicResponses).includes(brokerSecret), false); assert.doesNotMatch(JSON.stringify(publicResponses), /machineToken|onebotToken|x-hosted-service-secret/);
      assert.equal(llm.state.requests.length, 0); assert.equal(ob.state.sends.length, 0);
    });
    await t.test('restarting the front door preserves accounts, requests, preferences and resynchronizes worker', async () => {
      const before = workerCalls.filter(row => row.route === '/api/hosted/settings').length;
      await stop(); await boot();
      const overview = (await ok('GET', '/api/platform/hosted-bots', undefined, alice)).data;
      assert.equal(overview.requests[0].id, aliceRequest.id); assert.equal(overview.requests[0].expectedQQ, '10001');
      const prefs = (await ok('GET', '/api/platform/bot-preferences?botId=' + aliceRequest.botId, undefined, alice)).data;
      assert.equal(prefs.version, saved.version); assert.equal(prefs.effective.replyPercent, 55); assert.equal(prefs.effective.contextMessages, 44);
      await waitFor(() => workerCalls.filter(row => row.route === '/api/hosted/settings').length > before, 5000, 'front-door recovery settings');
      assert.equal(llm.state.requests.length, 0);
    });
  });

  test('independent real worker enforces identity, settings versions, leases, trigger probability and voice', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-hosted-worker-')), ob = createMockOneBotHttp(), ws = createMockOneBotWs(), llm = createMockLLM();
    let actualQQ = 10001, identityQueries = 0;
    const previousHandler = ob.server.listeners('request')[0]; ob.server.removeAllListeners('request');
    ob.server.on('request', (req, res) => { if (req.url !== '/get_login_info') return previousHandler(req, res); identityQueries++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: actualQQ, nickname: 'HostedFixture' } })); });
    const obPort = await listen(ob.server), wsPort = await ws.ready(), llmPort = await listen(llm.server), token = crypto.randomBytes(32).toString('base64url');
    writeConfig(root, syntheticConfig({ obPort, wsPort, appPort: await freePort(), token }));
    const child = fork(fileURLToPath(import.meta.url), ['--worker-fixture'], { env: { ...process.env, QQ_AGENT_DATA_DIR: root, QQ_AGENT_PUBLIC_ORIGIN: '', QQ_AGENT_HOSTED_CLIENT_CONFIG: '', QQ_AGENT_HOSTED_BOT_ID: 'hosted-' + 'a'.repeat(32), QQ_AGENT_HOSTED_EXPECTED_QQ: '10001', HOSTED_FIXTURE_LLM_PORT: String(llmPort) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = '', rpcId = 0; const pending = new Map();
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-12000); });
    const ready = new Promise((resolve, reject) => {
      child.on('message', message => { if (message.type === 'ready') resolve(message); const task = pending.get(message.id); if (task) { pending.delete(message.id); message.ok ? task.resolve(message.snapshot) : task.reject(Error(message.error)); } });
      child.once('exit', code => { if (code) reject(Error('Synthetic worker exited ' + code + '\n' + diagnostics)); });
    });
    const rpc = (command = 'snapshot', value) => new Promise((resolve, reject) => { const id = ++rpcId; pending.set(id, { resolve, reject }); child.send({ id, command, value }); });
    t.after(async () => { if (child.connected) { try { await rpc('stop'); } catch {} } if (child.exitCode === null) child.kill(); await ws.close(); await closeServer(ob.server); await closeServer(llm.server); assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-hosted-worker-'))); fs.rmSync(root, { recursive: true, force: true }); });
    let startupTimer;
    const { port } = await Promise.race([ready, new Promise((_, reject) => { startupTimer = setTimeout(() => reject(Error('Worker startup timeout\n' + diagnostics)), 20000); startupTimer.unref(); })]).finally(() => clearTimeout(startupTimer));
    const call = (method, route, body, suppliedToken = token, extraHeaders) => jsonRequest(port, { method, route, body, token: suppliedToken, extraHeaders });
    let version = 1, effective = { ...structuredClone(BOT_PREFERENCE_DEFAULTS), mentionOnly: true, replyPercent: 20, contextMessages: 8, groupIds: ['456'], privateIds: ['777'], personaText: 'WORKER_OWN_PERSONA' };
    const settings = (extra = {}) => ({ expectedQQ: '10001', version, defaultsVersion: 1, effective, leaseUntil: Date.now() + 90000, ...extra });
    const apply = async extra => { const result = await call('PUT', '/api/hosted/settings', settings(extra)); assert.equal(result.status, 200, result.text + '\n' + diagnostics); };
    let messageId = 50000;
    const push = (text, mention = false, selfId = 10001) => ws.push({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 777, self_id: selfId, message_id: ++messageId, time: Math.floor(Date.now() / 1000), sender: { user_id: 777, nickname: 'Fixture caller' }, message: [...(mention ? [{ type: 'at', data: { qq: String(selfId) } }] : []), { type: 'text', data: { text: text + ' ' + messageId } }] });
    const scriptText = () => { llm.state.script[llm.state.requests.length] = { model: FIXTURE_MODEL, toolCalls: [{ name: 'send_message', args: { messages: ['WORKER_SYNTHETIC_REPLY'] } }, { name: 'finish', args: { summary: 'Fixture done' } }] }; };
    await t.test('internal identity/settings require private token, expected QQ and monotonic versions', async () => {
      assert.equal((await call('GET', '/api/hosted/identity', undefined, 'wrong-fixture')).status, 401);
      const identity = await call('GET', '/api/hosted/identity'); assert.equal(identity.status, 200); assert.equal(identity.data.actualQQ, '10001'); assert.equal(identity.data.agentReady, true);
      assert.equal((await call('PUT', '/api/hosted/settings', settings({ expectedQQ: '10002' }))).status, 400);
      assert.equal((await call('PUT', '/api/hosted/settings', settings(), token, { origin: 'https://cross-site.example.invalid' })).status, 403);
      await apply();
      assert.equal((await call('PUT', '/api/hosted/settings', settings({ version: 0 }))).status, 409); await apply();
      const snapshot = await rpc(); assert.deepEqual(snapshot.config.allow, { groups: ['456'], private: ['777'] }); assert.equal(snapshot.config.botControls.replyPercent, 20); assert.equal(snapshot.config.botControls.contextMessages, 8); assert.equal(snapshot.config.persona.roleText, 'WORKER_OWN_PERSONA');
    });
    await t.test('mention-only admits the real at segment and blocks ordinary/nickname text', async () => {
      const before = llm.state.requests.length; push('HostedFixture 普通文本'); await sleep(350); assert.equal(llm.state.requests.length, before);
      scriptText(); push('fixture explicit question', true); await waitFor(() => ob.state.sends.length >= 1, 10000, 'mention reply through real Agent');
      await waitFor(async () => !(await rpc()).paused && llm.state.requests.length > before, 1000, 'worker unpaused');
    });
    await t.test('20 percent uses the strict threshold on real incoming group events', async () => {
      version++; effective = { ...effective, mentionOnly: false }; await apply(); await rpc('random', 0.2);
      const before = llm.state.requests.length; push('neutral threshold miss'); await sleep(350); assert.equal(llm.state.requests.length, before);
      await rpc('random', 0.199); scriptText(); const sends = ob.state.sends.length; push('neutral threshold hit'); await waitFor(() => ob.state.sends.length > sends, 10000, '20 percent threshold hit');
    });
    await t.test('a mismatching event self_id cannot use a previously cached expected QQ', async () => {
      const before = llm.state.requests.length;
      try { push('cached identity must reject another live account', false, 10002); await sleep(350); assert.equal(llm.state.requests.length, before); const state = await rpc(); assert.equal(state.paused, true); assert.equal(state.actualQQ, ''); }
      finally { await rpc('reconnect'); await apply(); }
    });
    await t.test('missing event self_id also invalidates the cached identity', async () => {
      const before = llm.state.requests.length;
      try { ws.push({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 777, message_id: ++messageId, message: [{ type: 'text', data: { text: 'missing identity must not enter Agent' } }] }); await sleep(250); assert.equal(llm.state.requests.length, before); assert.equal((await rpc()).paused, true); }
      finally { await rpc('reconnect'); await apply(); }
    });
    await t.test('sending rechecks live HTTP identity even when WebSocket identity was cached correctly', async () => {
      const sends = ob.state.sends.length, calls = llm.state.requests.length, queries = identityQueries;
      scriptText(); llm.state.script[calls].delayMs = 250; push('fixture delayed outgoing identity proof', true);
      await waitFor(() => llm.state.requests.length > calls, 5000, 'fake model dispatched'); actualQQ = 10002;
      try { await waitFor(async () => (await rpc()).runningCount === 0, 10000, 'wrong HTTP account stopped outgoing'); assert.equal(ob.state.sends.length, sends); assert.ok(identityQueries > queries); assert.equal((await rpc()).paused, true); }
      finally { actualQQ = 10001; await rpc('reconnect'); await apply(); }
    });
    await t.test('expired lease and a switched live QQ block paid model admission', async () => {
      version++; await apply({ leaseUntil: Date.now() + 100 }); await sleep(180);
      const before = llm.state.requests.length; push('expired lease must reject', true); await sleep(250); assert.equal(llm.state.requests.length, before);
      const renew = await call('PUT', '/api/hosted/lease', { expectedQQ: '10001', leaseUntil: Date.now() + 90000 }); assert.equal(renew.status, 200);
      await rpc('self', 10002); push('wrong identity must reject', true, 10002); await sleep(250); assert.equal(llm.state.requests.length, before);
      assert.equal((await call('PUT', '/api/hosted/settings', settings())).status, 409); await rpc('self', 10001); await apply();
    });
    await t.test('voice settings apply with fake credentials and synthesize only through the isolated provider', async () => {
      version++; effective = { ...effective, mentionOnly: true, voiceEnabled: true, autoVoicePercent: 20, voiceType: 101055, speed: 1, volume: -3 }; await apply();
      const state = await rpc(); assert.equal(state.speech.configured, true); assert.equal(state.speech.settings.enabled, true); assert.equal(state.speech.voiceType, 101055); assert.equal(state.speech.speed, 1); assert.equal(state.speech.volume, -3); assert.equal(state.speech.settings.autoVoicePercent, 20); assert.equal(state.speech.subsidy.dailyLimitCny, 0.3);
      const before = ob.state.sends.length;
      llm.state.script[llm.state.requests.length] = { model: FIXTURE_MODEL, toolCalls: [{ name: 'send_voice', args: { text: '隔离测试短句' } }, { name: 'finish', args: { summary: 'Fixture voice done' } }] };
      push('请用语音回复我', true); await waitFor(() => ob.state.sends.length > before, 10000, 'mock voice send');
      assert.match(JSON.stringify(ob.state.sends.at(-1)), /record/); const after = await rpc(); assert.equal(after.speechCalls, 1); assert.deepEqual(after.lastSpeech, { voiceType: 101055, speed: 1, volume: -3 });
      assert.ok(llm.state.requests.every(row => row.model === FIXTURE_MODEL));
    });
  });
}
