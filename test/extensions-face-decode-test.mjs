import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installReviewedExtensions, rollbackReviewedExtensions } from '../scripts/install-reviewed-extensions.mjs';
import { bootApp, waitFor } from './_harness.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'extensions.lock.json'), 'utf8'));
const item = lock.extensions.find(entry => entry.id === 'face-decode');
const expectedHash = '7f440d59dd91e7323677f7d6c59590bc0be6605c6f87db9f6aef8017b3080544';
const cache = process.env.QQ_AGENT_EXTENSION_CACHE || path.join(repo, '.local/interaction-review-2026-10-23');
const zipFile = [path.join(cache, 'plugins-face-decode.zip'), path.join(cache, expectedHash + '.zip')].find(file => fs.existsSync(file));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('face-decode lock pins the reviewed official archive and complete unmodified file set without vendoring', () => {
  assert.ok(item);
  assert.equal(item.kind, 'plugin');
  assert.equal(item.version, '1.1.0');
  assert.equal(item.moduleRoot, 'face-decode');
  assert.equal(item.source.downloadUrl, 'https://www.kondius.cn/api/community/plugins/face-decode/download');
  assert.equal(item.source.zipSha256, expectedHash);
  assert.equal(item.source.zipBytes, 5588);
  assert.deepEqual(item.sourceFiles, item.files);
  assert.deepEqual(item.files.map(file => file.path).sort(), ['index.js', 'lib/faces.mjs', 'plugin.json']);
  assert.deepEqual(item.permissions, []);
  assert.deepEqual(item.requires, []);
  assert.equal(item.license.status, 'not-declared');
  assert.equal(item.license.redistributeSource, false);
  assert.equal(item.adaptation, null);
});

test('reviewed face-decode uses the real installer, loader and Agent prompt without external requests', {
  skip: !zipFile && 'Cache the pinned official ZIP as plugins-face-decode.zip with QQ_AGENT_EXTENSION_CACHE for integration verification'
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-face-decode-'));
  const releaseRoot = path.join(root, 'release'), packagesDir = path.join(root, 'packages'), stateDir = path.join(root, 'receipts');
  fs.mkdirSync(releaseRoot); fs.mkdirSync(packagesDir);
  fs.writeFileSync(path.join(releaseRoot, 'package.json'), '{"type":"module"}');
  const archive = fs.readFileSync(zipFile);
  assert.equal(sha(archive), expectedHash);
  fs.writeFileSync(path.join(packagesDir, expectedHash + '.zip'), archive);
  const installOptions = { lock, packagesDir, releaseRoot, stateDir, ids: ['face-decode'] };
  const nativeFetch = globalThis.fetch;
  let externalRequests = 0, startupMetadataAttempts = 0, fixture, skillManager, loadPlugins, configApi, receipt;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      externalRequests++;
      return Promise.reject(Error('Face-decode fixture forbids external networking'));
    }
    return nativeFetch(input, init);
  };
  t.after(async () => {
    try {
      if (fixture) await fixture.app.stop(); // Surface shutdown errors; the legacy helper swallows them.
    } finally {
      if (skillManager) for (const module of skillManager.list()) skillManager.unregister(module.id);
      if (fixture) {
        fixture.app.onebot.close();
        fixture.app.server.closeAllConnections?.(); fixture.app.server.close();
        fixture.onebotWs.state.client?.terminate();
        await fixture.onebotWs.close();
        await Promise.all([fixture.onebotHttp.server, fixture.llm.server].map(server => new Promise(resolve => {
          server.closeAllConnections?.(); server.close(resolve);
        })));
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
      }
      globalThis.fetch = nativeFetch;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('preview is read-only, exact installation is idempotent and all three file hashes match', async () => {
    const preview = await installReviewedExtensions(installOptions);
    assert.equal(preview.dryRun, true);
    assert.equal(fs.existsSync(stateDir), false);
    assert.equal(fs.existsSync(path.join(releaseRoot, 'plugins')), false);
    receipt = (await installReviewedExtensions({ ...installOptions, dryRun: false })).receipt;
    const repeated = await installReviewedExtensions({ ...installOptions, dryRun: false });
    assert.equal(repeated.packages[0].status, 'unchanged');
    assert.equal(repeated.reloadRequired, false);
    for (const file of item.files) {
      const bytes = fs.readFileSync(path.join(releaseRoot, 'plugins/face-decode', file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(sha(bytes), file.sha256);
    }
  });

  await t.test('actual loader activates the plugin without registering tools or a new model client', async () => {
    // bootApp starts the actual app, whose native roots must not import an
    // unrelated developer/production extension before our explicit test roots.
    for (const name of ['plugins', 'skills']) {
      const nativeRoot = path.join(repo, name);
      assert.ok(!fs.existsSync(nativeRoot) || fs.readdirSync(nativeRoot).every(file => file === '.gitkeep'),
        'Run this integration in an isolated checkout with empty native extension roots');
    }
    fixture = await bootApp({ config: {
      api: { vision: false, maxRounds: 2 },
      allow: { groups: ['456'], private: ['456'] },
      extensions: { hotReload: false }, memory: { consolidateEnabled: false },
      sticker: { enabled: false, collectEnabled: false },
      proactive: { enabled: false }, webSearch: { enabled: false },
      skills: { 'face-decode': { enabled: true } }
    } });
    // The native app may attempt its own public metadata refresh at startup;
    // the fixture above blocks it. No package has been imported at this point.
    startupMetadataAttempts = externalRequests;
    ({ skillManager } = await import('../src/skills/manager.js'));
    ({ loadPlugins } = await import('../src/plugin-loader.js'));
    configApi = await import('../src/config.js');
    const loaded = await loadPlugins({ log() {}, roots: { skills: path.join(root, 'absent-skills'), plugins: path.join(releaseRoot, 'plugins') } });
    assert.deepEqual(loaded.failed, []);
    assert.deepEqual(loaded.loaded.map(module => module.id), ['face-decode']);
    assert.equal(skillManager.isActive('face-decode').active, true);
    assert.deepEqual(skillManager.registry.get('face-decode').toolIds, []);
    assert.equal(fixture.llm.state.requests.length, 0);
    assert.equal(externalRequests, startupMetadataAttempts);
  });

  await t.test('group and same-number private input reach actual model HTTP with decoded names and unknown IDs intact', async () => {
    for (const [kind, marker] of [['group', 'FACE_GROUP'], ['private', 'FACE_PRIVATE']]) {
      const index = fixture.llm.state.requests.length;
      fixture.llm.state.script[index] = { toolCalls: [{ name: 'finish', args: { summary: marker } }] };
      fixture.onebotWs.push({
        post_type: 'message', message_type: kind, ...(kind === 'group' ? { group_id: 456 } : {}),
        user_id: kind === 'group' ? 11111 : 456, self_id: 888,
        message_id: 91001 + index, time: Math.floor(Date.now() / 1000),
        sender: { user_id: kind === 'group' ? 11111 : 456, nickname: 'Fixture friend' },
        message: [
          { type: 'text', data: { text: `@覆盖Bot ${marker} ` } },
          { type: 'face', data: { id: '14' } },
          { type: 'face', data: { id: '999999' } }
        ]
      });
      await waitFor(() => fixture.llm.state.requests.length === index + 1, 10000, marker + ' model request');
      await fixture.app.orchestrator.whenArchiveIdle();
      const users = fixture.llm.state.requests[index].messages.filter(message => message.role === 'user');
      const prompt = JSON.stringify(users);
      assert.ok(prompt.includes(marker));
      assert.ok(prompt.includes('[表情:微笑]'));
      assert.ok(prompt.includes('[表情999999]'));
      assert.equal(prompt.includes(kind === 'group' ? 'FACE_PRIVATE' : 'FACE_GROUP'), false);
    }
    assert.equal(fixture.onebotHttp.state.sends.length, 0);
  });

  await t.test('multimodal user text translates idempotently without changing images, system or assistant messages', async () => {
    const messages = [
      { role: 'system', content: '[表情14]' },
      { role: 'assistant', content: '[表情14]' },
      { role: 'user', content: [{ type: 'text', text: '[表情14] [表情999999]' }, { type: 'image_url', image_url: { url: 'https://example.invalid/fixture.png' } }] }
    ];
    await skillManager.runHook('before-llm-messages', { chatKey: 'private:456', messages });
    const once = structuredClone(messages);
    await skillManager.runHook('before-llm-messages', { chatKey: 'private:456', messages });
    assert.deepEqual(messages, once);
    assert.equal(messages[0].content, '[表情14]');
    assert.equal(messages[1].content, '[表情14]');
    assert.equal(messages[2].content[0].text, '[表情:微笑] [表情999999]');
    assert.equal(messages[2].content[1].image_url.url, 'https://example.invalid/fixture.png');
  });

  await t.test('disable, re-enable, reload and exact rollback leave no hook or unrelated package residue', async () => {
    configApi.updateConfig({ skills: { 'face-decode': { enabled: false } } });
    skillManager.deactivate('face-decode');
    const disabled = [{ role: 'user', content: '[表情14]' }];
    await skillManager.runHook('before-llm-messages', { chatKey: 'group:456', messages: disabled });
    assert.equal(disabled[0].content, '[表情14]');
    configApi.updateConfig({ skills: { 'face-decode': { enabled: true } } });
    skillManager.activate('face-decode');
    const roots = { skills: path.join(root, 'absent-skills'), plugins: path.join(releaseRoot, 'plugins') };
    const reload = await loadPlugins({ log() {}, roots });
    assert.equal(reload.failed.length, 0);
    assert.equal(skillManager.list().filter(module => module.id === 'face-decode').length, 1);
    const enabled = [{ role: 'user', content: '[表情14]' }];
    await skillManager.runHook('before-llm-messages', { chatKey: 'group:456', messages: enabled });
    assert.equal(enabled[0].content, '[表情:微笑]');
    skillManager.unregister('face-decode');
    assert.equal(rollbackReviewedExtensions({ receiptFile: receipt, dryRun: false }).removed, 1);
    const removed = [{ role: 'user', content: '[表情14]' }];
    await skillManager.runHook('before-llm-messages', { chatKey: 'group:456', messages: removed });
    assert.equal(removed[0].content, '[表情14]');
    assert.equal(externalRequests, startupMetadataAttempts);
  });
});
