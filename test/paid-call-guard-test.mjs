import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JSDOM } from 'jsdom';

// Set before loading production config/LLM modules. All requests remain on loopback.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-paid-call-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { createPaidCallStorage, createPaidCallGuard, validateProductionBudgetConfig, closeProductionPaidCallGuard, productionPaidCallGuard, runWithPaidConversation, productionBudgetOverview, updateProductionBudgetLimits } = await import('../src/paid-call-guard.js');
const { runWithConversationContext } = await import('../src/conversation-context.js');
const { getConfig, setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { chatCompletion, chatCompletionWithRetry } = await import('../src/llm.js');
const { skillManager } = await import('../src/skills/manager.js');
test.after(() => { closeProductionPaidCallGuard(); assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'qq-agent-paid-call-test-'))); fs.rmSync(dataDir, { recursive: true, force: true }); });

function config(baseUrl = 'http://127.0.0.1:34567/v1') {
  return { ...structuredClone(DEFAULT_CONFIG), api: { ...structuredClone(DEFAULT_CONFIG.api), baseUrl, apiKey: 'fixture-platform-key', model: 'fixture-model' },
    allow: { groups: ['123', '456'], private: ['123'] }, deny: { groups: [], private: [] },
    productionBudget: { enabled: true, endpoint: baseUrl, model: 'fixture-model',
      prices: { inputCnyPerMillion: 2, cacheHitCnyPerMillion: 0.04, outputCnyPerMillion: 8, reasoningIncluded: true },
      defaultDailyLimitCny: 1, outputCap: 1024, overrides: {}, initialSpent: {}, imageTokensPerImage: 1024,
      funding: Object.fromEntries(['group:123', 'group:456', 'private:123'].map(key => [key, { mode: 'platform', enabled: true }])) } };
}
function context(key = 'group:123', extra = {}) { return { botId: 'primary', conversationKey: key, actorId: 'server-fixture', fundingRef: { id: 'platform', version: 1 }, personaRef: { id: 'persona-a', version: 1 }, requestId: crypto.randomUUID(), ...extra }; }
function inContext(work, key = 'group:123', extra = {}) { return runWithConversationContext(context(key, extra), work); }
const body = () => ({ model: 'fixture-model', stream: false, messages: [{ role: 'user', content: 'fixture prompt' }] });
const response = (usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, message = { role: 'assistant', content: 'fixture response' }) => JSON.stringify({ model: 'fixture-model', choices: [{ message, finish_reason: 'stop' }], usage });
function fixture(t) {
  const file = path.join(dataDir, crypto.randomUUID() + '.sqlite'), storage = createPaidCallStorage(file); let cfg = config(), clock = Date.parse('2026-10-22T04:00:00Z');
  let guard = createPaidCallGuard({ storage, config: () => cfg, now: () => clock });
  t.after(() => storage.close());
  return { file, storage, get cfg() { return cfg; }, set cfg(value) { cfg = value; }, get guard() { return guard; },
    clock: () => clock, now(value) { clock = Date.parse(value); }, advance(ms) { clock += ms; },
    rebuild() { guard = createPaidCallGuard({ storage, config: () => cfg, now: () => clock }); return guard; },
    prepare(extra = {}) { return guard.prepare({ api: { baseUrl: cfg.api.baseUrl, apiKey: cfg.api.apiKey, model: cfg.api.model }, platformCredential: cfg.api.apiKey, body: body(), ...extra }); },
  };
}

test('confirmed Command Code authentication rejection releases its hold and preserves the audit row', t => {
  const f = fixture(t);
  f.cfg = config('https://api.commandcode.ai/alpha');
  f.rebuild();
  inContext(() => {
    const token = f.prepare(); f.guard.dispatch(token);
    assert.ok(f.guard.status('group:123').reservedCny > 0);
    f.guard.complete(token, { status: 401, text: JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', status: 401 } }) });
    const records = f.guard.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, token.id);
    assert.equal(records[0].state, 'released');
    assert.equal(records[0].actualCny, null);
    assert.equal(f.guard.status('group:123').reservedCny, 0);
    assert.equal(f.guard.status('group:123').spentCny, 0);
  });
  f.rebuild();
  assert.equal(f.guard.records()[0].state, 'released');
});

test('authentication reconciliation does not guess from other statuses, endpoints, bodies or usage', t => {
  const rejected = { success: false, error: { code: 'UNAUTHORIZED', status: 401 } };
  const cases = [
    { status: 400, raw: rejected }, { status: 403, raw: rejected },
    { status: 429, raw: rejected }, { status: 500, raw: rejected },
    { status: 401, raw: { ...rejected, success: true } },
    { status: 401, raw: { ...rejected, error: { code: 'UNKNOWN', status: 401 } } },
    { status: 401, raw: { ...rejected, usage: null } },
    { status: 401, raw: { ...rejected, choices: [] } },
    { status: 401, raw: rejected, endpoint: 'https://fixture.example.test/v1' }
  ];
  for (const entry of cases) {
    const f = fixture(t); f.cfg = config(entry.endpoint || 'https://api.commandcode.ai/alpha'); f.rebuild();
    inContext(() => {
      const token = f.prepare(); f.guard.dispatch(token);
      f.guard.complete(token, { status: entry.status, text: JSON.stringify(entry.raw) });
      assert.equal(f.guard.records()[0].state, 'unknown');
      assert.ok(f.guard.status('group:123').reservedCny > 0);
    });
  }
});

test('strict production configuration refuses missing, unknown and malformed quotes', () => {
  for (const edit of [p => p.enabled = false, p => p.prices.inputCnyPerMillion = '2', p => p.prices.outputCnyPerMillion = NaN,
    p => p.prices.cacheHitCnyPerMillion = -1, p => delete p.prices.reasoningIncluded, p => p.endpoint = 'https://user:pass@example.invalid/v1',
    p => p.outputCap = 0, p => p.initialSpent = { '2026-02-30': {} }, p => p.funding = []]) {
    const cfg = config(); edit(cfg.productionBudget); assert.throws(() => validateProductionBudgetConfig(cfg), { code: 'PAID_CALL_DENIED' });
  }
  assert.equal(validateProductionBudgetConfig(config()).outputCap, 1024);
});

test('no context, absent whitelist/funding and BYOK cannot borrow the platform credential', t => {
  const f = fixture(t); assert.throws(() => f.prepare(), { code: 'PAID_CALL_DENIED' });
  inContext(() => assert.throws(() => f.prepare(), { code: 'PAID_CALL_DENIED' }), 'private:456');
  inContext(() => assert.throws(() => f.prepare(), { code: 'PAID_CALL_DENIED' }), 'group:123', { fundingRef: { id: 'byok-fixture', version: 1 } });
  inContext(() => { f.cfg.productionBudget.funding['group:123'].enabled = false; assert.throws(() => f.prepare(), { code: 'PAID_CALL_DENIED' }); });
  assert.equal(f.guard.records().length, 0);
});

test('final endpoint, model and credential must match explicit platform policy', t => {
  const f = fixture(t);
  for (const api of [{ ...f.cfg.api, model: 'unpriced-model' }, { ...f.cfg.api, baseUrl: 'https://example.invalid/v1' }, { ...f.cfg.api, apiKey: 'fixture-unapproved-key' }]) {
    inContext(() => assert.throws(() => f.prepare({ api }), { code: 'PAID_CALL_DENIED' }));
  }
  assert.equal(f.guard.records().length, 0);
});

test('output caps survive request rewrites and standard images receive a fixed 1024 token quote', t => {
  const f = fixture(t);
  inContext(() => {
    const small = body(); small.max_tokens = 100000; small.max_completion_tokens = 100000;
    small.messages[0].content = [{ type: 'text', text: 'fixture image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
    const large = structuredClone(small); large.messages[0].content[1].image_url.url += 'x'.repeat(100000);
    const a = f.prepare({ body: small }), b = f.prepare({ body: large });
    assert.equal(a.body.max_tokens, 1024); assert.equal(a.body.max_completion_tokens, undefined);
    const records = f.guard.records(); assert.equal(records[0].amountCny, records[1].amountCny);
    for (const part of [{ type: 'video_url', video_url: { url: 'https://example.invalid/video' } }, { type: 'input_audio', input_audio: { data: 'fixture' } }, { type: 'file', file: { file_id: 'fixture' } }]) {
      const unknown = body(); unknown.messages[0].content = [part]; assert.throws(() => f.prepare({ body: unknown }), { code: 'PAID_CALL_DENIED' });
    }
    f.guard.release(a); f.guard.release(b);
  });
});

test('initial spent is imported atomically once, including amounts above the new daily cap', t => {
  const f = fixture(t); f.cfg.productionBudget.initialSpent = { '2026-10-22': { 'group:123': 1.2, 'private:123': 0.1 } };
  // A fresh dedicated file demonstrates startup seeding rather than mutating a running marker.
  const storage = createPaidCallStorage(path.join(dataDir, crypto.randomUUID() + '.sqlite')); t.after(() => storage.close());
  let guard = createPaidCallGuard({ storage, config: () => f.cfg, now: f.clock });
  assert.equal(guard.status('group:123').spentCny, 1.2); assert.equal(guard.records().length, 2);
  guard = createPaidCallGuard({ storage, config: () => f.cfg, now: f.clock }); assert.equal(guard.records().length, 2);
  f.cfg.productionBudget.initialSpent['2026-10-22']['group:123'] = 0;
  assert.throws(() => createPaidCallGuard({ storage, config: () => f.cfg, now: f.clock }), { code: 'PAID_LEDGER_UNAVAILABLE' }); assert.equal(guard.records().length, 2);
});

test('80 percent shrinks direct replies, stops spontaneous and memory calls and persists a direct-request cooldown', t => {
  const f = fixture(t);
  // Seed this runtime ledger through a supplier-estimate settlement so initialization stays immutable.
  inContext(() => { const token = f.prepare(); f.guard.dispatch(token); f.guard.complete(token, { text: response({ prompt_tokens: 0, completion_tokens: 100000, total_tokens: 100000 }) }); });
  assert.equal(f.guard.status('group:123').spentCny, 0.8);
  for (const options of [{ purpose: 'proactive' }, { purpose: 'memory' }, { direct: false }]) inContext(() => assert.throws(() => f.prepare(options), { code: 'PAID_CALL_DENIED' }));
  f.advance(60_001);
  inContext(() => { const a = f.prepare(); assert.equal(a.body.max_tokens, 256); assert.match(JSON.stringify(a.body.messages), /120/); f.guard.dispatch(a); f.guard.complete(a, { text: response() });
    const toolFollowup = f.prepare(); f.guard.dispatch(toolFollowup); f.guard.complete(toolFollowup, { text: response() }); });
  inContext(() => { const b = f.prepare(); assert.throws(() => f.guard.dispatch(b), { code: 'PAID_CALL_DENIED' }); f.guard.release(b); });
  f.advance(60_001); inContext(() => { const c = f.prepare(); f.guard.dispatch(c); f.guard.complete(c, { text: response() }); });
});

test('same physical chat shares budget across personas while group/private remain separate', t => {
  const f = fixture(t);
  inContext(() => { const a = f.prepare(); f.guard.dispatch(a); f.guard.complete(a, { text: response() }); }, 'group:123', { personaRef: { id: 'persona-a', version: 1 } });
  const first = f.guard.status('group:123').spentCny;
  inContext(() => { const b = f.prepare(); f.guard.dispatch(b); f.guard.complete(b, { text: response() }); }, 'group:123', { personaRef: { id: 'persona-b', version: 8 } });
  assert.ok(f.guard.status('group:123').spentCny > first); assert.equal(f.guard.status('private:123').spentCny, 0);
  assert.equal(f.guard.records({ key: 'group:123' }).length, 2);
});

test('unknown usage survives restart and midnight and cannot silently become free money', t => {
  const f = fixture(t); f.now('2026-10-22T15:59:00Z');
  inContext(() => { const token = f.prepare(); f.guard.dispatch(token); f.guard.complete(token, { text: response(null) }); });
  const reserved = f.guard.status('group:123').reservedCny; assert.ok(reserved > 0); assert.equal(f.guard.records()[0].state, 'unknown');
  f.now('2026-10-22T16:01:00Z'); f.rebuild(); assert.equal(f.guard.status('group:123').date, '2026-10-23'); assert.equal(f.guard.status('group:123').reservedCny, reserved);
  inContext(() => { const token = f.prepare(); f.guard.dispatch(token); f.guard.complete(token, { text: response() }); });
  assert.ok(f.guard.status('group:123').spentCny > 0); assert.equal(f.guard.status('group:123').reservedCny, reserved);
});

test('funding revocation and a reduced cap are rechecked immediately before dispatch', t => {
  const f = fixture(t);
  inContext(() => { const token = f.prepare(); f.cfg.productionBudget.funding['group:123'].enabled = false; assert.throws(() => f.guard.dispatch(token), { code: 'PAID_CALL_DENIED' }); f.guard.release(token); });
  f.cfg.productionBudget.funding['group:123'].enabled = true;
  inContext(() => { const token = f.prepare(); f.cfg.productionBudget.overrides['group:123'] = 0; assert.throws(() => f.guard.dispatch(token), { code: 'PAID_CALL_DENIED' }); f.guard.release(token); });
  assert.equal(f.guard.records().filter(row => row.state === 'dispatched').length, 0);
});

test('corrupt ledger and initializer markers fail closed without replacing their contents', t => {
  const f = fixture(t), db = new DatabaseSync(f.file);
  db.prepare('UPDATE paid_documents SET body=? WHERE name=?').run('{fixture-corrupt', 'conversation-budget');
  assert.throws(() => f.guard.status('group:123')); assert.equal(db.prepare('SELECT body FROM paid_documents WHERE name=?').get('conversation-budget').body, '{fixture-corrupt'); db.close();
});

test('management limits expose only scoped budget data and reject price, funding and credential edits', t => {
  const previous = getConfig(), cfg = config(); closeProductionPaidCallGuard(); setRuntimeConfig(cfg);
  t.after(() => { closeProductionPaidCallGuard(); setRuntimeConfig(previous); });
  const view = productionBudgetOverview(), text = JSON.stringify(view);
  assert.equal(view.conversations.length, 3); for (const field of ['apiKey', 'fixture-platform-key', 'initialSpent', 'reasoningIncluded', 'endpoint']) assert.equal(text.includes(field), false);
  for (const patch of [{ prices: {} }, { funding: {} }, { endpoint: 'https://example.invalid' }, { apiKey: 'fixture-rejected' }, { initialSpent: {} }, { enabled: false }, { overrides: { 'private:999': 10 } }, { overrides: { 'group:123': '10' } }, { overrides: { __replace__: {} } }]) {
    assert.throws(() => updateProductionBudgetLimits({ version: view.version, ...patch }), { statusCode: 400 });
  }
  const updated = updateProductionBudgetLimits({ version: view.version, defaultDailyLimitCny: 2, overrides: { 'group:123': 0 } });
  assert.equal(updated.defaultDailyLimitCny, 2); assert.equal(updated.conversations.find(row => row.key === 'group:123').dailyLimitCny, 0);
  assert.throws(() => updateProductionBudgetLimits({ version: view.version, defaultDailyLimitCny: 1 }), { statusCode: 409 });
  const inherited = updateProductionBudgetLimits({ version: updated.version, overrides: { 'group:123': null } });
  assert.equal(Object.hasOwn(inherited.overrides, 'group:123'), false); assert.equal(inherited.conversations.find(row => row.key === 'group:123').dailyLimitCny, 2);
  assert.deepEqual(getConfig().productionBudget.prices, cfg.productionBudget.prices); assert.equal(getConfig().api.apiKey, 'fixture-platform-key');
});

test('native budget GET/PUT routes use the narrow limits contract', async t => {
  const previous = getConfig(); closeProductionPaidCallGuard(); setRuntimeConfig(config());
  t.after(() => { closeProductionPaidCallGuard(); setRuntimeConfig(previous); });
  const { createRoutes } = await import('../src/routes.js'); let incoming = {};
  const routes = createRoutes({ readBody: async () => incoming });
  const invoke = (method, extra = {}) => routes.find(route => route.method === method && route.pattern === '/api/production-budgets').handler({ req: {}, res: {}, json: (_, status, data) => ({ status, data }), ...extra });
  const first = await invoke('GET'); assert.equal(first.status, 200); incoming = { version: first.data.version, overrides: { 'group:456': 0.5 } };
  const saved = await invoke('PUT'); assert.equal(saved.status, 200); assert.equal(saved.data.overrides['group:456'], 0.5);
  incoming = { version: saved.data.version, funding: {} }; assert.equal((await invoke('PUT')).status, 400);
});

test('budget page shows live scoped costs and saves only narrow quota fields with inherited defaults', async t => {
  const html = fs.readFileSync(new URL('../ui/production-budgets.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/production-budgets.html', runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const view = { enabled: true, version: 'fixture-version', defaultDailyLimitCny: 1, overrides: { 'group:123': 0.5 }, conversations: [
    { key: 'group:123', date: '2026-10-22', state: 'degraded', spentCny: 0.4, reservedCny: 0.01, remainingCny: 0.09, unknownReservations: 1 },
    { key: 'private:123', date: '2026-10-22', state: 'normal', spentCny: 0, reservedCny: 0, remainingCny: 1, unknownReservations: 0 }
  ] };
  let submitted = null;
  dom.window.fetch = async (url, opts) => { assert.equal(url, '/api/production-budgets'); if (opts?.method === 'PUT') submitted = JSON.parse(opts.body); return { ok: true, json: async () => structuredClone(view) }; };
  dom.window.eval(fs.readFileSync(new URL('../ui/production-budgets.js', import.meta.url), 'utf8'));
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  const document = dom.window.document; assert.equal(document.querySelectorAll('article').length, 2); assert.match(document.body.textContent, /在途及未知/); assert.match(document.body.textContent, /费用待核对/);
  const inputs = document.querySelectorAll('article input[type=number]'); assert.equal(inputs[0].disabled, false); assert.equal(inputs[1].disabled, true);
  const defaultInput = document.getElementById('default-limit'); defaultInput.value = '2'; defaultInput.dispatchEvent(new dom.window.Event('input')); assert.equal(inputs[1].value, '2');
  inputs[0].value = '0.8'; document.getElementById('limits').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, { version: 'fixture-version', defaultDailyLimitCny: 2, overrides: { 'group:123': 0.8, 'private:123': null } }); assert.match(document.getElementById('status').textContent, /已保存/);
});

test('real local HTTP attempts preserve tools, cap retries, account memory and refuse absent scope/fallback', async t => {
  const requests = [], scripts = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text)); const next = scripts.shift() || { text: response() };
    if (next.hang) return;
    res.writeHead(next.status || 200, { 'content-type': 'application/json' }); res.end(next.text);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`, cfg = config(baseUrl), previous = getConfig();
  closeProductionPaidCallGuard(); setRuntimeConfig(cfg);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { const host = new URL(url).hostname; assert.ok(['127.0.0.1', 'localhost'].includes(host), 'fixture must not call the internet'); return nativeFetch(url, options); };
  t.after(async () => { closeProductionPaidCallGuard(); setRuntimeConfig(previous); globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(chatCompletion({ messages: [{ role: 'user', content: 'no trusted context' }] }), { code: 'PAID_CALL_DENIED' }); assert.equal(requests.length, 0);
  const tools = [{ type: 'function', function: { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object', properties: {} } } }];
  scripts.push({ text: response(undefined, { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] }) }, { text: response() });
  await runWithPaidConversation('group:123', async () => {
    const first = await chatCompletion({ messages: [{ role: 'user', content: 'use a fixture tool' }], tools }); assert.equal(first.message.tool_calls[0].function.name, 'fixture_tool');
    await chatCompletion({ messages: [{ role: 'user', content: 'fixture' }, first.message, { role: 'tool', tool_call_id: 'call-fixture', content: 'tool result' }], tools });
  });
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].tools, tools); assert.equal(requests[1].messages.at(-1).role, 'tool'); assert.equal(requests[0].max_tokens, 1024);
  scripts.push({ status: 500, text: JSON.stringify({ error: { message: 'fixture temporary' } }) }, { text: response() });
  await runWithPaidConversation('group:123', () => chatCompletionWithRetry({ messages: [{ role: 'user', content: 'retry fixture' }] }, 1));
  assert.equal(requests.length, 4); assert.equal(productionPaidCallGuard().records().filter(row => row.state === 'unknown').length, 1);
  scripts.push({ status: 400, text: JSON.stringify({ error: { message: 'unsupported thinking parameter' } }) }, { text: response() });
  cfg.api.thinkingEffort = 'high'; cfg.api.thinkingDialect = 'deepseek';
  // Force the same request transformation path used by plugins, then let built-in rejection recovery retry it.
  const nativeTransforms = skillManager.getRequestTransforms.bind(skillManager);
  skillManager.getRequestTransforms = () => [async ({ body }) => ({ ...body, thinking: { type: 'enabled' }, max_tokens: 999999 })];
  try { await runWithPaidConversation('group:123', () => chatCompletion({ messages: [{ role: 'user', content: 'parameter retry fixture' }] })); } finally { skillManager.getRequestTransforms = nativeTransforms; }
  assert.equal(requests.length, 6); assert.equal(requests[4].max_tokens, 1024); assert.equal(requests[5].max_tokens, 1024); assert.equal(requests[5].thinking, undefined);
  scripts.push({ text: response() }); await runWithPaidConversation('private:123', () => chatCompletion({ messages: [{ role: 'user', content: 'memory fixture' }], purpose: 'memory' }));
  assert.ok(productionPaidCallGuard().status('private:123').spentCny > 0);
  cfg.api.fallbackModels = [{ model: 'unknown-fallback' }]; scripts.push({ status: 500, text: '{}' });
  const before = requests.length;
  await assert.rejects(runWithPaidConversation('group:123', () => chatCompletionWithRetry({ messages: [{ role: 'user', content: 'fallback fixture' }] }, 0)), { code: 'PAID_CALL_DENIED' });
  assert.equal(requests.length, before + 1, 'unknown fallback is blocked before network');
  assert.equal(productionPaidCallGuard().records().filter(row => row.state === 'settled').length, 5);
  cfg.productionBudget.overrides['group:456'] = 0;
  await assert.rejects(runWithPaidConversation('group:456', () => chatCompletion({ messages: [{ role: 'user', content: 'zero quota' }] })), { code: 'PAID_CALL_DENIED' });
  assert.equal(requests.length, before + 1, 'zero quota never goes on the wire');
  scripts.push({ hang: true }); const controller = new AbortController();
  const cancelled = runWithPaidConversation('private:123', () => chatCompletion({ messages: [{ role: 'user', content: 'cancel fixture' }], signal: controller.signal }));
  while (requests.length < before + 2) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(Error('aborted fixture')); await assert.rejects(cancelled, /aborted fixture/);
  assert.equal(productionPaidCallGuard().records({ key: 'private:123' }).at(-1).state, 'unknown');

  // Exercise the actual Orchestrator memory entry, not a second model client.
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { ChatStore } = await import('../src/store.js');
  const { MemoryStore } = await import('../src/memory.js');
  const store = new ChatStore(), memory = new MemoryStore();
  store.appendIncoming('private:123', { mid: 1, ts: Date.now(), senderId: '123', senderName: 'Fixture friend', text: '我喜欢周末去公园散步。' });
  const orchestrator = new Orchestrator({ store, memory, stickers: {}, sender: {}, sessions: {}, onebot: {} });
  cfg.memory = { ...cfg.memory, useChatModel: true };
  scripts.push({ text: response(undefined, { role: 'assistant', content: JSON.stringify({ impressions: ['喜欢周末去公园散步'] }) }) });
  const countBeforeMemory = requests.length;
  const result = await orchestrator.consolidateMemoryForChat('private:123', { userIds: ['123'], force: true });
  assert.equal(result.failed.length, 0, JSON.stringify(result)); assert.equal(result.changed, 1); assert.equal(requests.length, countBeforeMemory + 1);
  const spent = productionPaidCallGuard().status('private:123').spentCny;
  cfg.productionBudget.overrides['private:123'] = Number((spent / 0.8).toFixed(6));
  const blocked = await orchestrator.consolidateMemoryForChat('private:123', { userIds: ['123'], force: true });
  assert.equal(blocked.failed.length, 1); assert.equal(requests.length, countBeforeMemory + 1, 'degraded background memory never calls model');
});
