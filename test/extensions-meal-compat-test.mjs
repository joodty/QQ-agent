import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MEAL_PATCH, verifyMealArchive, patchMealSource, patchMealEntry } from '../scripts/extensions/meal-compat.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.env.QQ_AGENT_EXTENSION_CACHE || path.join(repo, '.local/market-review-2026-10-23');
const zipFile = path.join(cache, 'skills-meal-picker.zip'), available = fs.existsSync(zipFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-meal-overlay-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function entry(bytes, suffix) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  assert.ok(end >= 0); let pos = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(pos), 0x02014b50);
    const len = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32);
    const name = bytes.subarray(pos + 46, pos + 46 + len).toString();
    if (name === suffix) {
      const offset = bytes.readUInt32LE(pos + 42), start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(pos + 20));
      return (bytes.readUInt16LE(pos + 10) === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: 200000 }) : compressed).toString('utf8');
    }
    pos += 46 + len + extra + comment;
  }
  throw Error('Reviewed package fixture entry missing');
}

test('meal overlay rejects arbitrary sources and ZIPs without executing code', () => {
  assert.throws(() => verifyMealArchive(Buffer.from('unreviewed ZIP')), e => e.code === 'MEAL_ARCHIVE_MISMATCH');
  assert.throws(() => patchMealSource('export const unreviewed = true;'), e => e.code === 'MEAL_SOURCE_MISMATCH');
  assert.throws(() => patchMealSource(null), e => e.code === 'MEAL_SOURCE_MISMATCH');
});

test('meal overlay previews and applies only the pinned official source, with idempotent replay', { skip: !available && 'Cache the pinned official ZIP with QQ_AGENT_EXTENSION_CACHE for integration verification' }, () => {
  const bytes = fs.readFileSync(zipFile); verifyMealArchive(bytes);
  const source = entry(bytes, 'meal-picker/index.js'), patched = patchMealSource(source);
  assert.equal(digest(source), MEAL_PATCH.sourceSha256); assert.equal(digest(patched), MEAL_PATCH.installedSha256);
  assert.equal(patchMealSource(patched), patched);
  const file = path.join(root, 'preview-index.js'); fs.writeFileSync(file, source);
  assert.equal(patchMealEntry({ zipFile, entryFile: file }).dryRun, true); assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(patchMealEntry({ zipFile, entryFile: file, dryRun: false }).changed, true);
  assert.equal(patchMealEntry({ zipFile, entryFile: file, dryRun: false }).changed, false);
  fs.appendFileSync(file, '\n// unreviewed local change');
  assert.throws(() => patchMealEntry({ zipFile, entryFile: file, dryRun: false }), e => e.code === 'MEAL_SOURCE_MISMATCH');
});

test('actual patched meal tool isolates chat/person identity through the real loader', { skip: !available && 'Cache the pinned official ZIP with QQ_AGENT_EXTENSION_CACHE for integration verification' }, async () => {
  const bytes = fs.readFileSync(zipFile); verifyMealArchive(bytes);
  const skills = path.join(root, 'skills'), dir = path.join(skills, 'meal-picker'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), patchMealSource(entry(bytes, 'meal-picker/index.js')));
  fs.writeFileSync(path.join(dir, 'skill.json'), entry(bytes, 'meal-picker/skill.json'));
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const { skillManager } = await import('../src/skills/manager.js');
  const { getTool } = await import('../src/tool-registry.js');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const nativeFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw Error('Meal fixture forbids all networking'); };
  try {
    const loaded = await loadPlugins({ log() {}, roots: { skills, plugins: path.join(root, 'missing-plugins') } });
    assert.equal(loaded.failed.length, 0); assert.equal(skillManager.isActive('meal-picker').active, true);
    const tool = getTool('meal-picker__pick_meal'); assert.ok(tool);
    const ctx = (chatKey, userId = '777') => ({ chatKey, kind: chatKey.split(':')[0], chatId: chatKey.split(':')[1], session: { trigger: [{ senderId: userId, senderName: 'Fixture person', self: false }] }, onebot: { call() { throw Error('Tool must not send QQ'); } } });
    // The same QQ and same numeric chat identifier each get independent quotas.
    for (const key of ['group:101', 'private:101', 'group:202']) {
      assert.match((await tool.execute(ctx(key), { meal: 'lunch' })).content, /还剩 1 次/);
      assert.match((await tool.execute(ctx(key), { meal: 'lunch' })).content, /还剩 0 次/);
      assert.match((await tool.execute(ctx(key), { meal: 'lunch' })).content, /已经用完/);
    }
    // A different real actor in the same chat has their own quota.
    assert.match((await tool.execute(ctx('group:101', '888'), { meal: 'lunch' })).content, /还剩 1 次/);
    // Extra model arguments cannot select another person's or another chat's quota.
    assert.match((await tool.execute(ctx('group:101'), { meal: 'lunch', userId: '888', chatKey: 'private:999' })).content, /已经用完/);
    assert.match((await tool.execute(ctx('group:101', '888'), { meal: 'lunch' })).content, /还剩 0 次/);
    // Dinner's existing independent limit remains three, without changing menus.
    assert.match((await tool.execute(ctx('group:101'), { meal: 'dinner' })).content, /还剩 2 次/);
    assert.equal((await tool.execute({ session: {} }, { meal: 'lunch' })).isError, true);
    assert.equal((await tool.execute({ chatKey: ['group:101'], session: {} }, { meal: 'lunch' })).isError, true);
    assert.deepEqual(Object.keys(tool.parameters.properties), ['meal']);
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = nativeFetch; skillManager.unregister('meal-picker'); }
});
