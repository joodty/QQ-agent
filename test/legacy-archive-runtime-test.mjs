// Full local Agent runtime: real prompt builder/model HTTP/OneBot HTTP+WS,
// synthetic identities, isolated DATA_DIR, no real QQ or paid model services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  makeDataDir, writeConfig, freePort, listen, sleep, waitFor,
  createMockOneBotHttp, createMockOneBotWs, createMockLLM
} from './_harness.mjs';

test('imported persona archives remain isolated through the actual Agent runtime', async t => {
  const dataDir = makeDataDir('qq-agent-archive-runtime-');
  const nativeFetch = globalThis.fetch;
  // Metadata refreshes must not turn an offline integration test into network I/O.
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return Promise.reject(new Error('External networking disabled by archive runtime fixture'));
    }
    return nativeFetch(input, init);
  };
  const onebotHttp = createMockOneBotHttp();
  const httpPort = await listen(onebotHttp.server);
  const onebotWs = createMockOneBotWs();
  const wsPort = await onebotWs.ready();
  const llm = createMockLLM();
  const llmPort = await listen(llm.server);
  const { ConversationArchives } = await import('../src/conversation-archives.js');
  const archiveFile = path.join(dataDir, 'conversation-archives.sqlite');
  const message = (text, id = 1) => ({
    id, mid: id, ts: 1000 + id, senderId: '11111', senderName: 'Fixture friend',
    text, self: false, read: true, reply: null, media: []
  });
  const archive = (id, chatKey, personaId, marker) => ({
    id, chatKey, personaId, legacySessionId: `legacy-${id}`, createdAt: 1, lastUsedAt: 1,
    messages: [message(marker)],
    transcript: [
      { kind: 'legacy-message', role: 'user', text: `${marker}_LEGACY_USER` },
      { kind: 'legacy-message', role: 'assistant', text: `${marker}_LEGACY_ASSISTANT` },
      { kind: 'legacy-tool', name: 'send_message', arguments: { messages: ['NEVER_REPLAY_OLD_TOOL'] } }
    ]
  });
  const seed = new ConversationArchives({ file: archiveFile });
  seed.importBundle({
    format: 'qq-bridge-archives', version: 1, sourceId: 'synthetic-runtime-fixture',
    personas: [
      { id: 'persona-a', name: 'Fixture A', content: 'ROLE_MARKER_A', version: 1, history: [] },
      { id: 'persona-b', name: 'Fixture B', content: 'ROLE_MARKER_B', version: 1, history: [] }
    ],
    archives: [
      archive('group-a', 'group:456', 'persona-a', 'GROUP_A_IMPORTED'),
      archive('group-b', 'group:456', 'persona-b', 'GROUP_B_IMPORTED'),
      archive('private-a', 'private:456', 'persona-a', 'PRIVATE_A_IMPORTED'),
      archive('private-b', 'private:456', 'persona-b', 'PRIVATE_B_IMPORTED')
    ],
    selected: [{ chatKey: 'group:456', archiveId: 'group-a' }, { chatKey: 'private:456', archiveId: 'private-b' }],
    coverage: {}
  }, { dryRun: false });
  seed.close();
  writeConfig(dataDir, {
    api: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'fixture-offline-key-for-testing', model: 'test-model-a', vision: false, maxRounds: 3 },
    snowluma: { wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${httpPort}`, accessToken: '' },
    persona: { botName: '覆盖Bot', roleText: 'NATIVE_GLOBAL_ROLE' },
    allow: { groups: ['456', '789'], private: ['456'] }, deny: { groups: [], private: [] }, allowAllWhenEmpty: false,
    wakeDelayMs: 220, drainDelayMs: 200, maxConcurrentRuns: 2, sessionRetryAttempts: 2,
    send: { minGapMs: 200, maxGapMs: 200, byLengthMs: 0, maxPerMinute: 1000, maxPerHour: 10000, dedupeWindowMs: 0 },
    store: { maxMessagesPerChat: 0, contextTier: 4, historyCount: 80 },
    proactive: { enabled: false }, sticker: { enabled: false, collectEnabled: false },
    memory: { consolidateEnabled: false }, extensions: { hotReload: false },
    webSearch: { enabled: false }, server: { port: await freePort(), token: '' }
  });
  const { createApp } = await import('../src/app.js');
  let app;
  let base;
  const start = async () => {
    app = createApp({ log: () => {} });
    base = `http://127.0.0.1:${await app.start()}`;
    await waitFor(() => app.onebot.connected && onebotWs.state.client?.readyState === 1, 10000, 'fake OneBot connected');
  };
  const stop = async () => {
    if (!app) return;
    const server = app.server;
    await app.stop();
    if (server.listening) await new Promise(resolve => server.once('close', resolve));
    app = null;
  };
  t.after(async () => {
    await stop();
    onebotWs.server.closeAllConnections?.();
    await onebotWs.close();
    await Promise.all([onebotHttp.server, llm.server].map(server => new Promise(resolve => {
      server.closeAllConnections?.(); server.close(resolve);
    })));
    globalThis.fetch = nativeFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await start();
  const api = async (method, url, body) => {
    const response = await fetch(base + url, {
      method, headers: { origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
  const select = async (chatKey, archiveId) => {
    const before = app.store.archiveSelection(chatKey);
    const response = await api('POST', '/api/conversation-archives/select', { chatKey, archiveId, expectedVersion: before.selectionVersion });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return app.store.archiveSelection(chatKey);
  };
  let mid = 40000;
  const push = (chatKey, marker) => {
    const [kind, id] = chatKey.split(':');
    onebotWs.push({
      post_type: 'message', message_type: kind, ...(kind === 'group' ? { group_id: Number(id) } : {}),
      user_id: kind === 'private' ? Number(id) : 11111, self_id: 888,
      message_id: ++mid, time: Math.floor(Date.now() / 1000),
      sender: { user_id: kind === 'private' ? Number(id) : 11111, card: 'Fixture friend', nickname: 'Fixture friend' },
      message: [{ type: 'text', data: { text: `@覆盖Bot ${marker}` } }]
    });
  };
  const scriptedReply = marker => ({ toolCalls: [
    { name: 'send_message', args: { messages: [`REPLY_${marker}`] } },
    { name: 'finish', args: { summary: `finished ${marker}` } }
  ] });
  const done = marker => waitFor(() => {
    const session = app.sessions.listSummaries(100).map(row => app.sessions.get(row.id))
      .find(row => JSON.stringify(row?.trigger ?? []).includes(marker));
    return session && !['waiting', 'running'].includes(session.status) ? session : null;
  }, 10000, `runtime session ${marker} done`);
  const run = async (chatKey, marker) => {
    const index = llm.state.requests.length;
    llm.state.script[index] = scriptedReply(marker);
    push(chatKey, marker);
    const session = await done(marker);
    assert.equal(session.status, 'done', JSON.stringify(session.error));
    assert.equal(llm.state.requests.length, index + 1, 'one expected model attempt');
    return { request: llm.state.requests[index], session };
  };
  const prompt = request => JSON.stringify(request.messages);
  let initialA;

  await t.test('startup discovers SQLite, GET exposes archives, imported history remains inert', async () => {
    assert.ok(app.store.archives);
    const listing = await api('GET', '/api/conversation-archives?chatKey=group%3A456');
    assert.equal(listing.status, 200);
    assert.match(JSON.stringify(listing.body), /group-a/);
    await sleep(300);
    assert.equal(llm.state.requests.length, 0);
    assert.equal(onebotHttp.state.sends.length, 0);
    initialA = app.store.archiveSelection('group:456');
  });

  await t.test('legacy ownership verification codes never enter new model history or trigger a paid reply', async () => {
    const requests = llm.state.requests.length, sends = onebotHttp.state.sends.length;
    const before = app.store.recent('private:456', { limit: 100 });
    for (const content of ['绑定 Abcd1234_Xyz', '/bind Abcd1234_Xyz']) {
      onebotWs.push({ post_type: 'message', message_type: 'private', user_id: 456, self_id: 888,
        message_id: ++mid, sender: { user_id: 456, nickname: 'Fixture friend' },
        message: content.startsWith('/bind') ? content : [{ type: 'text', data: { text: content } }] });
    }
    await sleep(450);
    assert.equal(llm.state.requests.length, requests);
    assert.equal(onebotHttp.state.sends.length, sends);
    assert.deepEqual(app.store.recent('private:456', { limit: 100 }), before);
  });

  await t.test('A→B→A uses separate real model prompts, messages, persona and member memory', async () => {
    app.memory.append('group:456', 'memberImpression', 'MEMORY_ONLY_A', { userId: '11111', target: 'Fixture friend' });
    const a = await run('group:456', 'A_FIRST');
    assert.match(prompt(a.request), /ROLE_MARKER_A/);
    assert.match(prompt(a.request), /GROUP_A_IMPORTED_LEGACY_USER/);
    assert.match(prompt(a.request), /MEMORY_ONLY_A/);
    assert.doesNotMatch(prompt(a.request), /GROUP_B_IMPORTED|ROLE_MARKER_B|NEVER_REPLAY_OLD_TOOL/);
    assert.equal(a.session.archiveSelection.archiveId, 'group-a');
    await select('group:456', 'group-b');
    app.memory.append('group:456', 'memberImpression', 'MEMORY_ONLY_B', { userId: '11111', target: 'Fixture friend' });
    const b = await run('group:456', 'B_FIRST');
    assert.match(prompt(b.request), /ROLE_MARKER_B|GROUP_B_IMPORTED/);
    assert.match(prompt(b.request), /MEMORY_ONLY_B/);
    assert.doesNotMatch(prompt(b.request), /A_FIRST|MEMORY_ONLY_A|GROUP_A_IMPORTED/);
    const back = await select('group:456', 'group-a');
    assert.equal(back.archiveId, initialA.archiveId);
    assert.ok(back.selectionVersion > initialA.selectionVersion);
    const again = await run('group:456', 'A_SECOND');
    assert.match(prompt(again.request), /A_FIRST/);
    assert.match(prompt(again.request), /REPLY_A_FIRST/);
    assert.match(prompt(again.request), /MEMORY_ONLY_A/);
    assert.doesNotMatch(prompt(again.request), /B_FIRST|MEMORY_ONLY_B|GROUP_B_IMPORTED/);
  });

  await t.test('group and private chats with the same number remain distinct', async () => {
    const result = await run('private:456', 'PRIVATE_FIRST');
    assert.match(prompt(result.request), /PRIVATE_B_IMPORTED|ROLE_MARKER_B/);
    assert.doesNotMatch(prompt(result.request), /GROUP_A_IMPORTED|A_FIRST|MEMORY_ONLY_A/);
    assert.equal(app.store.archiveSelection('group:456').archiveId, 'group-a');
    assert.equal(app.store.archiveSelection('private:456').archiveId, 'private-b');
  });

  await t.test('stale compare-and-swap select is rejected without changing the active archive', async () => {
    const before = app.store.archiveSelection('group:456');
    const result = await api('POST', '/api/conversation-archives/select', { chatKey: 'group:456', archiveId: 'group-b', expectedVersion: before.selectionVersion - 1 });
    assert.equal(result.status, 409);
    assert.deepEqual(app.store.archiveSelection('group:456'), before);
  });

  await t.test('restart restores A history and memory without replaying old messages or tools', async () => {
    const previous = app.store.archiveSelection('group:456');
    const attempts = llm.state.requests.length;
    const sends = onebotHttp.state.sends.length;
    await stop();
    await start();
    await sleep(300);
    assert.deepEqual(app.store.archiveSelection('group:456'), previous);
    assert.equal(llm.state.requests.length, attempts);
    assert.equal(onebotHttp.state.sends.length, sends);
    const result = await run('group:456', 'A_AFTER_RESTART');
    assert.match(prompt(result.request), /A_SECOND|REPLY_A_FIRST/);
    assert.match(prompt(result.request), /MEMORY_ONLY_A/);
    assert.doesNotMatch(prompt(result.request), /B_FIRST|MEMORY_ONLY_B/);
  });

  await t.test('switch cancels waiting work and clears cache anchors and active topics', async () => {
    const attempts = llm.state.requests.length;
    push('group:456', 'CANCEL_WAITING_A');
    await waitFor(() => app.orchestrator.pendingWake.has('group:456'), 3000, 'waiting archive A');
    app.orchestrator.promptAnchors.set('group:456', { readIds: [999], memberIds: [] });
    app.orchestrator.activeTopics.set('group:456', { topic: 'OLD_ARCHIVE_TOPIC', until: Date.now() + 100000 });
    await select('group:456', 'group-b');
    await select('group:456', 'group-a');
    await sleep(500);
    assert.equal(llm.state.requests.length, attempts);
    assert.equal(app.orchestrator.pendingWake.has('group:456'), false);
    assert.equal(app.orchestrator.promptAnchors.has('group:456'), false);
    assert.equal(app.orchestrator.activeTopics.has('group:456'), false);
  });

  await t.test('in-flight A→B→A cannot deliver an old model response or start paid retries', async () => {
    const index = llm.state.requests.length;
    const sends = onebotHttp.state.sends.length;
    llm.state.script[index] = { ...scriptedReply('STALE_INFLIGHT_A'), delayMs: 700 };
    push('group:456', 'STALE_INFLIGHT_A');
    await waitFor(() => llm.state.requests.length === index + 1, 5000, 'in-flight fake model');
    const old = app.store.archiveSelection('group:456');
    await select('group:456', 'group-b');
    const back = await select('group:456', 'group-a');
    assert.equal(back.archiveId, old.archiveId);
    assert.ok(back.selectionVersion >= old.selectionVersion + 2);
    const session = await done('STALE_INFLIGHT_A');
    assert.equal(session.status, 'aborted');
    await sleep(850);
    assert.equal(llm.state.requests.length, index + 1);
    assert.equal(onebotHttp.state.sends.length, sends);
  });

  await t.test('text, sticker, image, media and poke queued before an ABA switch are all rejected', async () => {
    const sends = onebotHttp.state.sends.length;
    const pokes = onebotHttp.state.pokes.length;
    const jobs = app.store.withArchive('group:456', () => [
      app.sender.sendTextBatch('group:456', ['QUEUED_OLD_A_FIRST', 'QUEUED_OLD_A_SECOND']),
      app.sender.sendSticker('group:456', { id: 'fixture', url: 'file:///fixture.png' }),
      app.sender.sendImage('group:456', { dataUrl: 'base64://AA==' }),
      app.sender.sendMedia('group:456', [{ type: 'video', data: { file: 'file:///fixture.mp4' } }]),
      app.sender.poke('group:456', '11111')
    ].map(job => job.then(value => ({ ok: true, value }), error => ({ ok: false, error }))));
    await sleep(30);
    await select('group:456', 'group-b');
    await select('group:456', 'group-a');
    const results = await Promise.all(jobs);
    assert.ok(results.every(result => !result.ok), JSON.stringify(results));
    assert.equal(onebotHttp.state.sends.length, sends);
    assert.equal(onebotHttp.state.pokes.length, pokes);
  });

  await t.test('switch during provider retry backoff prevents another actual HTTP attempt', async () => {
    const attempts = llm.state.requests.length;
    llm.state.forceStatus.push(500);
    push('group:456', 'CANCEL_MODEL_RETRY');
    await waitFor(() => llm.state.requests.length === attempts + 1, 5000, 'first failing model attempt');
    await select('group:456', 'group-b');
    await select('group:456', 'group-a');
    assert.equal((await done('CANCEL_MODEL_RETRY')).status, 'aborted');
    await sleep(1100);
    assert.equal(llm.state.requests.length, attempts + 1);
  });

  await t.test('a proactive wake uses the current persona archive and preserves its scope', async () => {
    await select('group:456', 'group-b');
    const index = llm.state.requests.length;
    llm.state.script[index] = scriptedReply('PROACTIVE_B');
    await app.orchestrator.wake('group:456', { proactive: true });
    assert.equal(llm.state.requests.length, index + 1);
    assert.match(prompt(llm.state.requests[index]), /GROUP_B_IMPORTED|ROLE_MARKER_B/);
    assert.doesNotMatch(prompt(llm.state.requests[index]), /A_FIRST|MEMORY_ONLY_A/);
    await select('group:456', 'group-a');
    assert.doesNotMatch(JSON.stringify(app.store.recent('group:456', { limit: 100 })), /PROACTIVE_B/);
  });

  await t.test('in-flight memory consolidation cannot write into A or B after an ABA switch', async () => {
    const index = llm.state.requests.length;
    llm.state.script[index] = { content: JSON.stringify({ impressions: ['STALE_MEMORY_OUTPUT'] }), delayMs: 700 };
    const job = app.orchestrator.consolidateMemoryForChat('group:456', { userIds: ['11111'], force: true })
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    await waitFor(() => llm.state.requests.length === index + 1, 5000, 'memory model request');
    await select('group:456', 'group-b');
    await select('group:456', 'group-a');
    const outcome = await job;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /档案已切换/);
    await sleep(750);
    assert.equal(llm.state.requests.length, index + 1);
    assert.doesNotMatch(JSON.stringify(app.memory.query('group:456')), /STALE_MEMORY_OUTPUT/);
    await select('group:456', 'group-b');
    assert.doesNotMatch(JSON.stringify(app.memory.query('group:456')), /STALE_MEMORY_OUTPUT/);
    await select('group:456', 'group-a');
  });

  await t.test('a send already accepted by OneBot is recorded in its original archive after switching', async () => {
    const sendText = app.onebot.sendText.bind(app.onebot);
    let accepted;
    const didAccept = new Promise(resolve => { accepted = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    app.onebot.sendText = async (...args) => {
      const value = await sendText(...args);
      accepted(); await gate; return value;
    };
    try {
      const job = app.store.withArchive('group:456', () => app.sender.sendTextBatch('group:456', ['ACCEPTED_BEFORE_SWITCH']));
      await didAccept;
      await select('group:456', 'group-b');
      release();
      await job;
      assert.doesNotMatch(JSON.stringify(app.store.recent('group:456', { limit: 100 })), /ACCEPTED_BEFORE_SWITCH/);
      await select('group:456', 'group-a');
      assert.match(JSON.stringify(app.store.recent('group:456', { limit: 100 })), /ACCEPTED_BEFORE_SWITCH/);
    } finally { release(); app.onebot.sendText = sendText; }
  });

  await t.test('an old failed session cannot be retried after A→B→A', async () => {
    const selection = app.store.archiveSelection('group:456');
    const entry = app.store.appendIncoming('group:456', { text: 'OLD_FAILED_TRIGGER', ts: Date.now(), senderId: '11111', senderName: 'Fixture friend' });
    const session = app.sessions.create({ chatKey: 'group:456', trigger: [entry], triggerSummary: 'OLD_FAILED_TRIGGER' });
    session.archiveSelection = selection;
    session.error = 'synthetic failure';
    app.sessions.finish(session.id, 'error');
    await select('group:456', 'group-b');
    await select('group:456', 'group-a');
    app.store.markAllRead('group:456');
    const result = app.orchestrator.retrySession(session.id);
    assert.equal(result.ok, false);
    assert.match(result.reason, /档案已切换/);
    assert.equal(app.store.unreadCount('group:456'), 0);
  });

  await t.test('unmanaged chats retain native runtime persistence and their global persona', async () => {
    const result = await run('group:789', 'UNMANAGED_NATIVE');
    assert.match(prompt(result.request), /NATIVE_GLOBAL_ROLE/);
    assert.doesNotMatch(prompt(result.request), /GROUP_A_IMPORTED|PRIVATE_B_IMPORTED|MEMORY_ONLY_A/);
    assert.equal(result.session.archiveSelection, null);
    assert.equal(app.store.archiveSelection('group:789'), null);
    assert.ok(fs.existsSync(path.join(dataDir, 'messages', 'group_789.json')));
    assert.equal(onebotHttp.state.sends.some(row => JSON.stringify(row.body).includes('NEVER_REPLAY_OLD_TOOL')), false);
  });

  await t.test('shutdown waits for a successful in-flight send to be archived before SQLite closes', async () => {
    const sendingApp = app;
    const original = sendingApp.onebot.sendText.bind(sendingApp.onebot);
    let accepted;
    const didAccept = new Promise(resolve => { accepted = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    sendingApp.onebot.sendText = async (...args) => {
      const result = await original(...args);
      accepted(); await gate; return result;
    };
    const job = sendingApp.store.withArchive('group:456', () => sendingApp.sender.sendTextBatch('group:456', ['ACCEPTED_DURING_SHUTDOWN']));
    await didAccept;
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    try {
      await sleep(40);
      assert.equal(stopped, false, 'shutdown must wait for the accepted OneBot response');
    } finally { release(); }
    await job;
    await stopping;
    await start();
    assert.match(JSON.stringify(app.store.recent('group:456', { limit: 100 })), /ACCEPTED_DURING_SHUTDOWN/);
  });
});
