import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { importLegacyBundle } from '../scripts/import-legacy-archives.mjs';
import { ConversationArchives } from '../src/conversation-archives.js';
import { ChatStore } from '../src/store.js';
import { archiveHistorySection, switchConversationArchive } from '../src/archive-runtime.js';
import { setArchivePersonaResolver, personaForChat, getConfig } from '../src/config.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-archive-cli-fixture-'));
  const file = path.join(root, 'bundle.json');
  const bundle = { format: 'qq-bridge-archives', version: 1, sourceId: 'fixture-source',
    personas: [{ id: 'fixture-persona', name: '原人设', content: 'fixture persona text', version: 1, history: [] }],
    archives: [{ id: 'fixture-archive', chatKey: 'private:910001', personaId: 'fixture-persona', legacySessionId: 'fixture-session',
      createdAt: 1000, lastUsedAt: 2000, messages: [{ id: 1, mid: null, ts: 1000, senderId: '910001', senderName: 'fixture',
        text: '此前聊过的话', self: false, read: true, reply: null, media: [] }], transcript: [] }],
    selected: [{ chatKey: 'private:910001', archiveId: 'fixture-archive' }], coverage: { status: 'partial', reason: 'bounded fixture history' } };
  fs.writeFileSync(file, JSON.stringify(bundle));
  return { root, file, bundle, dataDir: path.join(root, 'new-data') };
}

test('preview never creates destination and partial apply requires explicit acceptance', () => {
  const f = fixture(), source = fs.readFileSync(f.file);
  const preview = importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir });
  assert.equal(preview.applied, false); assert.equal(preview.archivesAdded, 1);
  assert.equal(fs.existsSync(f.dataDir), false);
  assert.throws(() => importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true }), /allow-partial/);
  assert.equal(fs.existsSync(f.dataDir), false);
  assert.deepEqual(fs.readFileSync(f.file), source);
});

test('accepted import/reimport preserves later chat and selected archive', () => {
  const f = fixture();
  importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true, allowPartial: true });
  const store = new ConversationArchives({ file: path.join(f.dataDir, 'conversation-archives.sqlite') });
  const state = store.readChat('private:910001');
  state.messages.push({ id: state.nextLocalId++, mid: null, ts: 3000, senderId: 'self', senderName: '我', text: '导入后继续聊', self: true, read: true, reply: null, media: [] });
  store.writeChat(state); store.close();
  const again = importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true, allowPartial: true });
  assert.equal(again.messagesAdded, 0);
  const reopened = new ConversationArchives({ file: path.join(f.dataDir, 'conversation-archives.sqlite') });
  assert.equal(reopened.readChat('private:910001').messages.at(-1).text, '导入后继续聊'); reopened.close();
});

test('unknown format is rejected without destination writes', () => {
  const f = fixture(); f.bundle.version = 999; fs.writeFileSync(f.file, JSON.stringify(f.bundle));
  assert.throws(() => importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true, allowPartial: true }), /版本|格式/);
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('raw/internal/replaced events stay stored without becoming live prompt or tools', () => {
  const f = fixture();
  f.bundle.archives[0].transcript = [
    { kind: 'legacy-dsh-header', sessionId: 'fixture-session', raw: { id: 'fixture-session' } },
    { kind: 'legacy-event', raw: { type: 'tool-call', command: 'fixture-must-never-run' } },
    { kind: 'legacy-message', role: 'user', text: 'fixture-internal-control', containsInternalControl: true, resumeEligible: false },
    { kind: 'legacy-message', role: 'assistant', text: 'fixture-replaced-content', resumeEligible: false },
    { kind: 'legacy-message', sessionId: 'fixture-child-session', role: 'assistant', text: 'fixture-subagent-private-task', resumeEligible: true },
    { kind: 'legacy-message', role: 'assistant', text: '上次约好周末看电影', resumeEligible: true },
  ];
  fs.writeFileSync(f.file, JSON.stringify(f.bundle));
  importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true, allowPartial: true });
  const archives = new ConversationArchives({ file: path.join(f.dataDir, 'conversation-archives.sqlite') });
  const store = new ChatStore(1, { archives }), section = archiveHistorySection(store, 'private:910001');
  assert.match(section, /周末看电影/); assert.doesNotMatch(section, /fixture-(?:internal|replaced|must-never|subagent)/);
  assert.deepEqual(archives.transcript('private:910001'), f.bundle.archives[0].transcript);
  store.appendIncoming('private:910001', { text: '后来聊的话', senderId: '910001' });
  assert.equal(archives.readChat('private:910001').messages.length, 2, 'native context cap must not delete imported archive history');
  archives.close();
});

test('selecting the current archive is a no-op and does not cancel a valid run', () => {
  const f = fixture(); importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true, allowPartial: true });
  const archives = new ConversationArchives({ file: path.join(f.dataDir, 'conversation-archives.sqlite') });
  const store = new ChatStore(0, { archives }); let cancelled = false;
  const before = store.archiveSelection('private:910001');
  const after = switchConversationArchive({ store, orchestrator: { archiveChanged() { cancelled = true; } },
    chatKey: 'private:910001', archiveId: before.archiveId, expectedVersion: before.selectionVersion });
  assert.equal(cancelled, false); assert.equal(after.selectionVersion, before.selectionVersion); archives.close();
});

test('global persona lookup remains available when imported chat resolution is installed', () => {
  const f = fixture(); importLegacyBundle({ bundleFile: f.file, dataDir: f.dataDir, apply: true, allowPartial: true });
  const archives = new ConversationArchives({ file: path.join(f.dataDir, 'conversation-archives.sqlite') });
  const store = new ChatStore(0, { archives });
  setArchivePersonaResolver(chatKey => store.archivePersona(chatKey));
  try {
    assert.deepEqual(personaForChat(), getConfig().persona);
    assert.equal(personaForChat('private:910001').roleText, 'fixture persona text');
  } finally { setArchivePersonaResolver(null); archives.close(); }
});

test('archive page switches persona, preserves errors, and renders imported names as text', async () => {
  const html = fs.readFileSync(new URL('../ui/archives.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/archives.html', runScripts: 'outside-only' });
  const { window } = dom;
  let selected = 'a', version = 1, reject = false;
  const calls = [];
  window.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body); calls.push(body);
      if (reject) return { ok: false, json: async () => ({ error: '档案已被其他操作切换，请刷新' }) };
      assert.equal(body.expectedVersion, version); selected = body.archiveId; version++;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ enabled: true, chats: ['private:910001'],
      archives: [{ archiveId: 'a', persona: { name: '<img src=x onerror=bad()>' } }, { archiveId: 'b', persona: { name: 'B' } }],
      selected: { archiveId: selected, selectionVersion: version, persona: { name: selected } }, messages: [] }) };
  };
  window.eval(fs.readFileSync(new URL('../ui/archives.js', import.meta.url), 'utf8'));
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  const chat = window.document.getElementById('chat'); chat.value = 'private:910001'; chat.dispatchEvent(new window.Event('change')); await flush();
  assert.equal(window.document.querySelectorAll('article img').length, 0);
  window.document.querySelectorAll('article button')[1].click(); await flush();
  assert.equal(selected, 'b'); assert.equal(calls.length, 1);
  assert.equal(window.document.querySelectorAll('article button')[1].textContent, '当前使用');
  reject = true; window.document.querySelectorAll('article button')[0].click(); await flush();
  assert.match(window.document.getElementById('status').textContent, /其他操作/);
  assert.equal(window.document.querySelectorAll('article button')[0].disabled, false);
  dom.window.close();
});
