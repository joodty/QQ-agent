// The real orchestrator, tool registry, sender, transport and paid ledger run
// together. Both network boundaries are replaced before any model can run.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-commandcode-orchestrator-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { SendQueue } = await import('../src/sender.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { productionPaidCallGuard, closeProductionPaidCallGuard, setPaidCallFundingServices } = await import('../src/paid-call-guard.js');

test('real orchestrator completes two Command Code tool rounds, preserves reasoning and settles both guarded requests', async t => {
  const endpoint = 'https://api.commandcode.ai/alpha', model = 'deepseek/deepseek-v4.1-flash';
  const key = 'private:123', reply = 'COMMANDCODE_ORCHESTRATOR_SYNTHETIC_REPLY';
  const reasoning = 'FIXTURE_REASONING_STAYS_IN_HISTORY';
  const previousConfig = getConfig(), previousFetch = globalThis.fetch;
  closeProductionPaidCallGuard(); setPaidCallFundingServices(null);
  setRuntimeConfig({ ...structuredClone(DEFAULT_CONFIG),
    api: { ...structuredClone(DEFAULT_CONFIG.api), baseUrl: endpoint, model, apiKey: 'fixture-commandcode-key',
      vision: false, maxRounds: 2, timeoutMs: 2000, fallbackModels: [] },
    allow: { groups: [], private: ['123'] }, deny: { groups: [], private: [] }, allowAllWhenEmpty: false,
    persona: { ...structuredClone(DEFAULT_CONFIG.persona), botName: 'FixtureBot', roleText: 'Synthetic integration-test assistant.' },
    send: { minGapMs: 1, maxGapMs: 1, byLengthMs: 0, maxPerMinute: 1000, maxPerHour: 10000, dedupeWindowMs: 0 },
    store: { ...structuredClone(DEFAULT_CONFIG.store), contextTier: 4, historyCount: 10 },
    proactive: { enabled: false }, chatActive: { enabled: false }, memory: { consolidateEnabled: false },
    sticker: { enabled: false, collectEnabled: false }, webSearch: { enabled: false }, extensions: { hotReload: false },
    productionBudget: { enabled: true, endpoint, model,
      prices: { inputCnyPerMillion: 2.4, cacheHitCnyPerMillion: .048, outputCnyPerMillion: 9.6, reasoningIncluded: true },
      defaultDailyLimitCny: 10, totalDailyLimitCny: 10, outputCap: 128, overrides: {}, initialSpent: {},
      funding: { [key]: { mode: 'platform', enabled: true } } }
  });
  const store = new ChatStore(), memory = new MemoryStore(), sessions = new SessionRegistry();
  const sent = [], events = [], wire = [];
  const onebot = { selfId: '888', selfNickname: 'FixtureBot', connected: true,
    async sendText(kind, id, text) { sent.push({ kind, id, text }); return { message_id: 7000 + sent.length }; } };
  const sender = new SendQueue({ store, onebot });
  const orchestrator = new Orchestrator({ store, memory, sessions, sender, onebot, stickers: {},
    emit: (type, payload) => events.push({ type, payload }) });
  t.after(async () => {
    await orchestrator.abortAll(); await orchestrator.whenArchiveIdle(); sessions.flushIndexCache();
    globalThis.fetch = previousFetch; closeProductionPaidCallGuard(); setPaidCallFundingServices(null); setRuntimeConfig(previousConfig);
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'qq-commandcode-orchestrator-')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110,
    inputTokenDetails: { cacheReadTokens: 40 }, outputTokenDetails: { reasoningTokens: 2 } };
  const ndjson = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  globalThis.fetch = async (url, options) => {
    // No native fetch fallback: an unexpected address fails inside the fixture.
    assert.equal(String(url), endpoint + '/generate');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, 'Bearer fixture-commandcode-key');
    const body = JSON.parse(options.body);
    wire.push(body);
    assert.equal(body.params.model, model); assert.equal(body.params.max_tokens, 128);
    assert.equal(productionPaidCallGuard().records().at(-1).state, 'dispatched');
    assert.doesNotMatch(JSON.stringify(body.params.messages), /"raw"|"inlineParsed"|"rescued"|chat\.completion/);
    if (wire.length === 1) {
      assert.ok(body.params.tools.some(tool => tool.name === 'get_chats'));
      assert.ok(body.params.tools.some(tool => tool.name === 'send_message'));
      return new Response(ndjson([
        { type: 'reasoning-start', id: 'fixture-reasoning' },
        { type: 'reasoning-delta', id: 'fixture-reasoning', text: reasoning },
        { type: 'reasoning-end', id: 'fixture-reasoning' },
        { type: 'tool-call', toolCallId: 'fixture_get_chats', toolName: 'get_chats', input: { limit: 1 } },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: usage }
      ]), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    assert.equal(wire.length, 2, 'Unexpected model retry or additional tool round');
    const live = [...sessions.current.values()][0];
    const savedAssistant = live.messages.find(message => message.role === 'assistant');
    assert.ok(savedAssistant.raw, 'Exercise the real orchestrator entry carrying local raw diagnostics');
    assert.equal(savedAssistant.reasoning_content, reasoning);
    assert.ok(live.messages.some(message => message.toolCall?.name === 'get_chats' && !message.toolCall.isError));
    const assistant = body.params.messages.find(message => message.role === 'assistant');
    assert.ok(assistant.content.some(part => part.type === 'reasoning' && part.text === reasoning));
    assert.ok(assistant.content.some(part => part.type === 'tool-call' && part.toolCallId === 'fixture_get_chats' && part.toolName === 'get_chats'));
    const result = body.params.messages.find(message => message.role === 'tool');
    assert.equal(result.content[0].type, 'tool-result');
    assert.equal(result.content[0].toolCallId, 'fixture_get_chats');
    assert.equal(result.content[0].toolName, 'get_chats');
    assert.match(result.content[0].output.value, /private:123/);
    return new Response(ndjson([
      { type: 'tool-call', toolCallId: 'fixture_send', toolName: 'send_message', input: { messages: [reply] } },
      { type: 'tool-call', toolCallId: 'fixture_finish', toolName: 'finish', input: { summary: 'Synthetic fixture done' } },
      { type: 'finish', finishReason: 'tool-calls', totalUsage: usage }
    ]), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };

  store.appendIncoming(key, { mid: '6001', ts: Date.now(), senderId: '123', senderName: 'Fixture caller',
    text: 'Read the available chats, then send the synthetic fixture reply and finish.' });
  await orchestrator.wake(key);
  assert.equal(wire.length, 2);
  assert.deepEqual(sent, [{ kind: 'private', id: '123', text: reply }]);
  const ended = events.find(event => event.type === 'session-end');
  assert.ok(ended, 'The real orchestrator finishes its session');
  assert.equal(ended.payload.status, 'done');
  const session = sessions.get(ended.payload.sessionId);
  assert.equal(session.rounds, 2); assert.equal(session.usage.calls, 2);
  assert.equal(session.sent[0].text, reply);
  const tools = session.messages.filter(message => message.toolCall).map(message => message.toolCall);
  assert.deepEqual(tools.map(tool => tool.name), ['get_chats', 'send_message', 'finish']);
  assert.ok(tools.every(tool => !tool.isError));
  const guard = productionPaidCallGuard(), records = guard.records({ key });
  assert.equal(records.length, 2); assert.ok(records.every(record => record.state === 'settled'));
  assert.equal(guard.status(key).reservedCny, 0);
  assert.ok(guard.status(key).spentCny > 0);
  assert.equal(guard.status(key).spentCny, records.reduce((sum, row) => sum + row.actualCny, 0));
  assert.equal(guard.totalStatus().spentCny, guard.status(key).spentCny);
});
