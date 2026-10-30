import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-instance-total-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { createPaidCallStorage, createPaidCallGuard, setPaidCallFundingServices, closeProductionPaidCallGuard } = await import('../src/paid-call-guard.js');
const { runWithConversationContext } = await import('../src/conversation-context.js');
test.after(() => { setPaidCallFundingServices(null); closeProductionPaidCallGuard(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture(t, { total = 1, initialSpent = {}, trial = false } = {}) {
  setPaidCallFundingServices(null);
  const cfg = {
    api: { baseUrl: 'https://fixture.example.test/v1', model: 'fixture-model', apiKey: 'fixture-platform-key' },
    allow: { groups: ['123', '456'], private: ['123'] }, deny: { groups: [], private: [] },
    productionBudget: { enabled: true, endpoint: 'https://fixture.example.test/v1', model: 'fixture-model',
      prices: { inputCnyPerMillion: 2, cacheHitCnyPerMillion: .04, outputCnyPerMillion: 8, reasoningIncluded: true },
      defaultDailyLimitCny: 10, outputCap: 1024, overrides: {}, initialSpent,
      funding: Object.fromEntries(['group:123', 'group:456', 'private:123'].map(key => [key, { mode: 'platform', enabled: true }])) }
  };
  if (trial) setPaidCallFundingServices({
    resolve: () => ({ id: 'fixture-trial', version: 1, mode: 'trial', endpoint: cfg.productionBudget.endpoint,
      model: cfg.productionBudget.model, prices: cfg.productionBudget.prices, responseModels: [], scopeAuthorized: true }),
    policy: () => ({ trial: { dailyLimitCny: 10, initialSpent: {} } })
  });
  if (total !== undefined && total !== null) cfg.productionBudget.totalDailyLimitCny = total;
  let clock = Date.parse('2026-10-24T04:00:00Z');
  const file = path.join(root, crypto.randomUUID() + '.sqlite');
  let storage = createPaidCallStorage(file), guard;
  try { guard = createPaidCallGuard({ storage, config: () => cfg, now: () => clock }); }
  catch (error) { storage.close(); throw error; }
  t.after(() => storage.close());
  const context = key => ({ botId: 'primary', conversationKey: key, actorId: 'fixture',
    fundingRef: { id: trial ? 'fixture-trial' : 'platform', version: 1 }, personaRef: { id: 'fixture-persona', version: 1 }, requestId: crypto.randomUUID() });
  const within = (ticket, work) => runWithConversationContext(ticket.context, work);
  const response = amount => JSON.stringify({ model: 'fixture-model', usage: { prompt_tokens: 0, completion_tokens: Math.round(amount * 1e6 / 8) } });
  return {
    cfg, file, get storage() { return storage; }, get guard() { return guard; },
    advance(ms) { clock += ms; },
    rebuild() { storage.close(); storage = createPaidCallStorage(file); guard = createPaidCallGuard({ storage, config: () => cfg, now: () => clock }); },
    llm(key = 'group:123', fields = {}) {
      const ticket = { context: context(key) };
      ticket.token = within(ticket, () => guard.prepare({ api: cfg.api, platformCredential: cfg.api.apiKey,
        body: { model: cfg.api.model, stream: false, messages: [{ role: 'user', content: 'fixture prompt' }] }, ...fields }));
      return ticket;
    },
    speech(key = 'group:123', amountCny = .1) {
      const ticket = { context: context(key) };
      ticket.token = within(ticket, () => guard.prepareService({ service: 'speech', amountCny,
        assertAuthorized: () => ({ id: 'fixture-speech', version: 'fixture-v1', scopeDailyLimitCny: 10, platformDailyLimitCny: 10, cooldownMs: 1000 }) }));
      return ticket;
    },
    dispatch(ticket) { return within(ticket, () => guard.dispatch(ticket.token)); },
    dispatchSpeech(ticket) { return within(ticket, () => guard.dispatchService(ticket.token)); },
    complete(ticket, amount) { return guard.complete(ticket.token, { text: response(amount) }); }
  };
}

test('unlimited mode tracks shared instance and trial costs and restores their existing caps', t => {
  const f = fixture(t, { trial: true, total: .001 }); f.cfg.productionBudget.enforceLimits = false;
  const llm = f.llm(); f.dispatch(llm); f.complete(llm, .02);
  const voice = f.speech('private:123', .03); f.dispatchSpeech(voice); f.guard.settleService(voice.token);
  assert.equal(f.guard.totalStatus().state, 'unlimited'); assert.equal(f.guard.trialStatus().state, 'unlimited');
  assert.equal(f.guard.totalStatus().spentCny, .05); assert.equal(f.guard.trialStatus().spentCny, .05);
  const records = f.guard.records(); f.rebuild(); assert.deepEqual(f.guard.records(), records);
  f.cfg.productionBudget.enforceLimits = true;
  assert.equal(f.guard.totalStatus().state, 'exhausted');
  assert.throws(() => f.llm('group:456'), { code: 'PAID_CALL_DENIED' });
  assert.deepEqual(f.guard.records(), records);
});

test('confirmed authentication rejection releases conversation, trial and instance holds together', t => {
  const f = fixture(t, { trial: true });
  f.cfg.api.baseUrl = f.cfg.productionBudget.endpoint = 'https://api.commandcode.ai/alpha';
  const ticket = f.llm(); f.dispatch(ticket);
  assert.ok(f.guard.status('group:123').reservedCny > 0);
  assert.ok(f.guard.trialStatus().reservedCny > 0);
  assert.ok(f.guard.totalStatus().reservedCny > 0);
  f.guard.complete(ticket.token, { status: 401, text: JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', status: 401 } }) });
  assert.equal(f.guard.status('group:123').reservedCny, 0);
  assert.equal(f.guard.trialStatus().reservedCny, 0);
  assert.equal(f.guard.totalStatus().reservedCny, 0);
  f.rebuild();
  assert.equal(f.guard.records()[0].state, 'released');
  assert.equal(f.guard.totalStatus().spentCny, 0);
});

test('LLM and speech across group/private resources share reservation, dispatch, settlement and release totals', t => {
  const f = fixture(t), llm = f.llm(), speech = f.speech('private:123', .1);
  const reserved = f.guard.totalStatus().reservedCny;
  assert.ok(reserved > .1);
  f.dispatch(llm); f.dispatchSpeech(speech);
  f.complete(llm, .1); f.guard.settleService(speech.token);
  assert.equal(f.guard.totalStatus().spentCny, .2);
  assert.equal(f.guard.totalStatus().reservedCny, 0);
  assert.equal(f.guard.status('group:123').spentCny, .1);
  assert.equal(f.guard.status('private:123').spentCny, .1);
  const releasedLLM = f.llm('group:456'), releasedSpeech = f.speech('private:123');
  f.guard.release(releasedLLM.token); f.guard.releaseService(releasedSpeech.token);
  assert.equal(f.guard.totalStatus().reservedCny, 0);
  assert.equal(f.guard.totalStatus().spentCny, .2);
});

test('failed aggregate admission rolls back every scope/service hold and never spends unrelated resources', t => {
  const f = fixture(t), first = f.speech('group:123', .39), second = f.speech('private:123', .39);
  assert.equal(f.guard.totalStatus().reservedCny, .78);
  assert.throws(() => f.speech('group:456', .1), { code: 'PAID_CALL_DENIED' });
  assert.equal(f.guard.records({ key: 'group:456' }).length, 0);
  assert.equal(f.guard.totalStatus().reservedCny, .78);
  f.guard.releaseService(first.token); f.guard.releaseService(second.token);
  f.cfg.productionBudget.totalDailyLimitCny = 0;
  assert.throws(() => f.llm('group:456'), { code: 'PAID_CALL_DENIED' });
  assert.equal(f.guard.records({ key: 'group:456' }).length, 0);
});

test('trial, instance and speech subsidy ledgers count the same call exactly once per applicable ceiling', t => {
  const f = fixture(t, { trial: true }), llm = f.llm('group:123'), speech = f.speech('private:123', .1);
  assert.equal(f.guard.totalStatus().reservedCny, f.guard.trialStatus().reservedCny);
  f.dispatch(llm); f.dispatchSpeech(speech); f.complete(llm, .1); f.guard.settleService(speech.token);
  f.complete(llm, .1); f.guard.settleService(speech.token);
  assert.equal(f.guard.totalStatus().spentCny, .2);
  assert.equal(f.guard.trialStatus().spentCny, .2);
  assert.equal(f.guard.totalStatus().reservedCny, 0);
});

test('unknown LLM/speech charges retain aggregate reservations through restart and midnight', t => {
  const f = fixture(t), llm = f.llm('group:123'), speech = f.speech('private:123');
  f.dispatch(llm); f.dispatchSpeech(speech);
  f.guard.unknown(llm.token); f.guard.unknownService(speech.token);
  const original = f.guard.totalStatus();
  assert.equal(original.unknownReservations, 2);
  assert.throws(() => f.guard.release(llm.token));
  assert.throws(() => f.guard.releaseService(speech.token));
  f.advance(86400000); f.rebuild();
  const restarted = f.guard.totalStatus();
  assert.equal(restarted.unknownReservations, 2);
  assert.equal(restarted.reservedCny, original.reservedCny);
  assert.equal(restarted.date, '2026-10-25');
});

test('capless original ledgers remain compatible and create no aggregate charges', t => {
  const f = fixture(t, { total: null });
  const llm = f.llm(), speech = f.speech('private:123');
  f.dispatch(llm); f.dispatchSpeech(speech); f.complete(llm, .1); f.guard.settleService(speech.token);
  assert.equal(f.guard.totalStatus(), null);
  assert.equal(f.storage.readText('instance-total-budget'), null);
  f.rebuild(); assert.equal(f.guard.totalStatus(), null);
  assert.equal(f.guard.status('group:123').spentCny, .1);
});

test('speech reserved before an aggregate cap is enabled must be rejected before dispatch', t => {
  const f = fixture(t, { total: null });
  const speech = f.speech('group:123');
  f.cfg.productionBudget.totalDailyLimitCny = 0;
  assert.throws(() => f.dispatchSpeech(speech), { code: 'PAID_LEDGER_UNAVAILABLE' });
  assert.equal(f.guard.records()[0].state, 'reserved');
  f.guard.releaseService(speech.token);
});

test('aggregate 80-percent transition blocks previously reserved background and unshortened LLM calls', t => {
  const f = fixture(t), memory = f.llm('group:456', { purpose: 'memory' }), fullReply = f.llm('private:123'), spending = f.llm('group:123');
  assert.equal(memory.token.degraded, false); assert.equal(fullReply.token.degraded, false);
  f.dispatch(spending); f.complete(spending, .8);
  assert.equal(f.guard.totalStatus().action, 'degrade');
  assert.equal(f.guard.status('group:456').action, 'normal');
  assert.throws(() => f.dispatch(memory), { code: 'PAID_CALL_DENIED' });
  assert.throws(() => f.dispatch(fullReply), { code: 'PAID_CALL_DENIED' });
  f.guard.release(memory.token); f.guard.release(fullReply.token);
  const direct = f.llm('private:123');
  assert.equal(direct.token.degraded, true);
  assert.equal(direct.token.body.max_tokens, 256);
  f.dispatch(direct); f.complete(direct, .01);
});

test('adding an aggregate ceiling to a ledger with historical spending is explicitly refused', t => {
  const f = fixture(t, { total: null });
  const old = f.llm('group:123'); f.dispatch(old); f.complete(old, .8);
  f.cfg.productionBudget.totalDailyLimitCny = .5;
  assert.throws(() => f.guard.totalStatus(), { code: 'PAID_LEDGER_UNAVAILABLE' });
  assert.throws(() => f.llm('group:456'), { code: 'PAID_LEDGER_UNAVAILABLE' });
  assert.equal(f.guard.status('group:123').spentCny, .8);
  assert.equal(f.guard.records({ key: 'group:456' }).length, 0);
});

test('a new aggregate ceiling cannot silently ignore initial legacy spending', t => {
  assert.throws(() => fixture(t, { total: .5, initialSpent: { '2026-10-24': { 'group:123': .4, 'private:123': .2 } } }), { code: 'PAID_LEDGER_UNAVAILABLE' });
});

test('an enabled aggregate ceiling cannot be removed to create an unaccounted interval',t=>{
 const f=fixture(t),ticket=f.llm('group:123');f.dispatch(ticket);f.complete(ticket,.1);
 delete f.cfg.productionBudget.totalDailyLimitCny;
 assert.throws(()=>f.llm('group:456'),{code:'PAID_LEDGER_UNAVAILABLE'});
 assert.throws(()=>f.guard.totalStatus(),{code:'PAID_LEDGER_UNAVAILABLE'});
 f.cfg.productionBudget.totalDailyLimitCny=1;
 assert.equal(f.guard.totalStatus().spentCny,.1);
});
