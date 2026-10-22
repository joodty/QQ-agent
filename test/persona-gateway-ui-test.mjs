// Real native persona DOM handlers, production gateway policy and isolated config.
// No QQ, model server, credentials or production state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { adminProxyRouteAllowed } from '../src/admin-gateway.js';

test('native persona saves use exact chat patches accepted by the admin gateway', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-persona-gateway-'));
  const previousDir = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = dataDir;
  const config = await import('../src/config.js');
  config.setArchivePersonaResolver(null);
  const initial = {
    persona: { botName: 'Fixture bot', roleText: 'Global fixture persona', participation: 'medium', customRules: 'Global rules', systemPromptOverride: '' },
    personaUnified: false,
    personaByChat: {
      'group:456': { roleText: 'Old group fixture', participation: 'high', customRules: 'Old rules', systemPromptOverride: 'Old override' },
      'private:456': { roleText: 'Private fixture', participation: 'low' },
      'group:789': { roleText: 'Other group fixture' }
    },
    allow: { groups: ['456', '789'], private: ['456'] },
    server: { port: 3210 }, productionBudget: { enabled: true }
  };
  config.setRuntimeConfig(structuredClone(initial));
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://console.example.test:8445/' });
  t.after(() => {
    config.setArchivePersonaResolver(null); dom.window.close();
    if (previousDir === undefined) delete process.env.QQ_AGENT_DATA_DIR; else process.env.QQ_AGENT_DATA_DIR = previousDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const win = dom.window, calls = [], alerts = [];
  Object.assign(win, {
    state: { config: structuredClone(initial), personaTemplates: {} },
    formatChatTitle: key => key, chatNameOf: () => '', renderSettings: () => {}, loadSettings: () => {},
    renderPersonaPicker: () => '', alert: text => alerts.push(text),
    esc: text => { const element = win.document.createElement('span'); element.textContent = text; return element.innerHTML; },
    modelModalShell: ({ body, foot }) => {
      const overlay = win.document.createElement('section'); overlay.innerHTML = body + foot;
      win.document.body.append(overlay); return overlay;
    },
    closeModelModal: overlay => overlay.remove(),
    api: async (route, options) => {
      const patch = JSON.parse(options.body);
      assert.equal(route, '/api/config'); assert.equal(options.method, 'POST');
      assert.equal(adminProxyRouteAllowed('POST', route, patch), true, 'actual serialized UI patch must pass the unchanged gateway');
      calls.push(patch); config.updateConfig(patch);
      return { ok: true, config: config.getConfig() };
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../ui/app/06-settings-render.js', import.meta.url), 'utf8'), dom.getInternalVMContext());
  // Keep the real modal handlers; a section re-render/whole settings reload is
  // outside this fixture, which has intentionally not booted the other UI parts.
  win.renderSettings = () => {}; win.loadSettings = () => {};
  const click = async selector => { win.document.querySelector(selector).click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(alerts, []); };

  await t.test('group save replaces edited fields without changing a private chat with the same number', async () => {
    win.openPerChatPersonaModal('group:456');
    win.document.querySelector('#pcp-roletext').value = 'New group fixture';
    win.document.querySelector('#pcp-participation').value = '';
    win.document.querySelector('#pcp-customrules').value = '';
    win.document.querySelector('#pcp-sysprompt').value = '';
    await click('#pcp-save');
    assert.deepEqual(Object.keys(calls.at(-1)), ['personaByChat']);
    assert.deepEqual(Object.keys(calls.at(-1).personaByChat), ['group:456']);
    assert.equal(JSON.stringify(calls.at(-1)).includes('__replace__'), false);
    assert.equal(config.personaForChat('group:456').roleText, 'New group fixture');
    assert.equal(config.personaForChat('group:456').participation, 'medium');
    assert.equal(config.personaForChat('group:456').customRules, 'Global rules');
    assert.equal(config.personaForChat('group:456').systemPromptOverride, '');
    assert.deepEqual(config.getConfig().personaByChat['private:456'], initial.personaByChat['private:456']);
    assert.deepEqual(config.getConfig().personaByChat['group:789'], initial.personaByChat['group:789']);
    assert.deepEqual(config.getConfig().server, initial.server); assert.deepEqual(config.getConfig().productionBudget, initial.productionBudget);
  });
  await t.test('clear sends null for exactly one key and restores the actual global persona', async () => {
    win.openPerChatPersonaModal('group:456'); await click('#pcp-clear');
    assert.deepEqual(calls.at(-1), { personaByChat: { 'group:456': null } });
    assert.deepEqual(config.personaForChat('group:456'), initial.persona);
    assert.equal(config.personaForChat('private:456').roleText, 'Private fixture');
  });
  await t.test('private save and all-empty save preserve group settings and inherit global after clearing', async () => {
    win.openPerChatPersonaModal('private:456'); win.document.querySelector('#pcp-roletext').value = 'New private fixture'; await click('#pcp-save');
    assert.deepEqual(Object.keys(calls.at(-1).personaByChat), ['private:456']);
    assert.equal(config.personaForChat('private:456').roleText, 'New private fixture');
    win.openPerChatPersonaModal('private:456');
    for (const selector of ['#pcp-roletext', '#pcp-participation', '#pcp-customrules', '#pcp-sysprompt']) win.document.querySelector(selector).value = '';
    await click('#pcp-save');
    assert.deepEqual(calls.at(-1), { personaByChat: { 'private:456': null } });
    assert.deepEqual(config.personaForChat('private:456'), initial.persona);
    assert.equal(config.personaForChat('group:789').roleText, 'Other group fixture');
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.personaByChat['private:456'], null);
    assert.equal(persisted.personaByChat['group:456'], null);
  });
  await t.test('global modal remains a partial patch and imported archives retain their selected version', async () => {
    win.openGlobalPersonaModal(); win.document.querySelector('#gp-roletext').value = 'New global fixture'; await click('#gp-save');
    assert.deepEqual(Object.keys(calls.at(-1)), ['persona']);
    assert.equal(config.personaForChat('private:456').roleText, 'New global fixture');
    config.setArchivePersonaResolver(key => key === 'group:456' ? { roleText: 'Imported preserved version' } : null);
    assert.equal(config.personaForChat('group:456').roleText, 'Imported preserved version');
    const section = win.renderPersonaSection(config.getConfig());
    assert.match(section, /href="\/archives.html"/); assert.match(section, /不会改写旧档案/);
    assert.equal(adminProxyRouteAllowed('POST', '/api/config', { personaByChat: { __replace__: {} } }), false);
    assert.equal(adminProxyRouteAllowed('POST', '/api/config', { server: { port: 1234 } }), false);
  });
});
