import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installReviewedExtensions, rollbackReviewedExtensions, readReviewedZip } from '../scripts/install-reviewed-extensions.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(0x314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((entry.mode ?? 0x81a4) * 65536) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    local.push(lh, name, data); central.push(ch, name); offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-extension-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, 'release'), packagesDir = path.join(root, 'packages'), stateDir = path.join(root, 'state');
  fs.mkdirSync(releaseRoot); fs.mkdirSync(packagesDir);
  const lock = { format: 'qq-agent-extension-lock', version: 1, extensions: [] };
  function add(id = 'fixture-module', change = {}) {
    const manifest = Buffer.from(JSON.stringify({ id, version: '1.0.0', apiVersion: 1 }));
    const files = new Map([['skill.json', manifest], ['index.js', Buffer.from('export function setup() {}\n')]]);
    const archive = zip([...files].map(([name, data]) => ({ name: `${id}/${name}`, data })));
    const sha256 = hash(archive); fs.writeFileSync(path.join(packagesDir, `${sha256}.zip`), archive);
    const item = { id, kind: 'skill', moduleRoot: id, version: '1.0.0', manifest: 'skill.json', source: { zipSha256: sha256, zipBytes: archive.length }, defaults: { enabled: true, settings: {} }, files: [...files].map(([name, data]) => ({ path: name, sha256: hash(data), bytes: data.length })), adaptation: null, ...change };
    lock.extensions.push(item); return item;
  }
  return { root, releaseRoot, packagesDir, stateDir, lock, add };
}

test('preview validates exact ZIP without creating state, roots or executing package JS', async t => {
  const f = fixture(t); f.add(); const before = fs.readdirSync(f.root);
  const result = await installReviewedExtensions(f);
  assert.equal(result.dryRun, true); assert.equal(result.packages[0].status, 'new');
  assert.deepEqual(fs.readdirSync(f.root), before); assert.deepEqual(fs.readdirSync(f.releaseRoot), []);
});

test('install caches exact originals, is idempotent, and rollback preserves unrelated files/config', async t => {
  const f = fixture(t); const item = f.add();
  const config = path.join(f.releaseRoot, 'fixture-config.json'); fs.writeFileSync(config, '{"fixture":true}');
  const result = await installReviewedExtensions({ ...f, dryRun: false });
  assert.equal(result.reloadRequired, true); assert.equal(hash(fs.readFileSync(path.join(f.stateDir, 'cache', `${item.source.zipSha256}.zip`))), item.source.zipSha256);
  const duplicate = await installReviewedExtensions({ ...f, dryRun: false });
  assert.equal(duplicate.packages[0].status, 'unchanged'); assert.equal(duplicate.reloadRequired, false);
  assert.equal(rollbackReviewedExtensions({ receiptFile: duplicate.receipt, dryRun: false }).removed, 0);
  assert.equal(rollbackReviewedExtensions({ receiptFile: result.receipt }).eligible, 1);
  assert.equal(fs.existsSync(path.join(f.releaseRoot, 'skills', item.id)), true);
  assert.equal(rollbackReviewedExtensions({ receiptFile: result.receipt, dryRun: false }).removed, 1);
  assert.equal(rollbackReviewedExtensions({ receiptFile: result.receipt, dryRun: false }).removed, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"fixture":true}');
});

test('a changed installed file prevents both overwrite and destructive rollback', async t => {
  const f = fixture(t); const item = f.add(); const result = await installReviewedExtensions({ ...f, dryRun: false });
  const target = path.join(f.releaseRoot, 'skills', item.id, 'index.js'); fs.appendFileSync(target, '// operator edit');
  await assert.rejects(installReviewedExtensions(f), /FILE_HASH_MISMATCH/);
  assert.throws(() => rollbackReviewedExtensions({ receiptFile: result.receipt, dryRun: false }), /FILE_HASH_MISMATCH/);
  assert.match(fs.readFileSync(target, 'utf8'), /operator edit/);
});

test('batch failure rolls back earlier atomic directory and leaves no half-built module', async t => {
  const f = fixture(t); const first = f.add('fixture-first'), second = f.add('fixture-second');
  fs.mkdirSync(path.join(f.stateDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, 'cache', `${second.source.zipSha256}.zip`), 'poisoned fixture');
  await assert.rejects(installReviewedExtensions({ ...f, dryRun: false }), /CACHE_HASH_MISMATCH/);
  assert.equal(fs.existsSync(path.join(f.releaseRoot, 'skills', first.id)), false);
  assert.equal(fs.existsSync(path.join(f.releaseRoot, 'skills', second.id)), false);
  assert.equal(fs.readdirSync(f.releaseRoot).some(name => name.startsWith('.reviewed-')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, '.install.lock')), false);
});

test('ZIP traversal, absolute names, duplicate/case aliases, links and foreign roots are rejected', () => {
  for (const entries of [
    [{ name: 'fixture/../escape', data: 'x' }],
    [{ name: '/fixture/index.js', data: 'x' }],
    [{ name: 'fixture/a', data: 'x' }, { name: 'fixture/A', data: 'y' }],
    [{ name: 'fixture/index.js', data: 'x', mode: 0xa1ff }],
    [{ name: 'other/index.js', data: 'x' }],
    [{ name: 'fixture/C:escape', data: 'x' }]
  ]) assert.throws(() => readReviewedZip(zip(entries), 'fixture'));
});

test('corrupt ZIP CRC/local directory disagreement and declared expansion bombs are rejected', () => {
  const good = zip([{ name: 'fixture/index.js', data: 'fixture' }]);
  const badCrc = Buffer.from(good); badCrc[30 + 'fixture/index.js'.length] ^= 1;
  assert.throws(() => readReviewedZip(badCrc, 'fixture'), /ZIP_CONTENT_MISMATCH/);
  const badName = Buffer.from(good); badName[30] = 120;
  assert.throws(() => readReviewedZip(badName, 'fixture'), /ZIP_HEADER_MISMATCH/);
  const bomb = Buffer.from(good); const central = good.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(9 * 1024 * 1024, 22); bomb.writeUInt32LE(9 * 1024 * 1024, central + 24);
  assert.throws(() => readReviewedZip(bomb, 'fixture'), /ARCHIVE_EXPANSION_LIMIT/);
});

test('missing source, extra files, mismatched ZIP and manifest identity do not write', async t => {
  const f = fixture(t); const item = f.add();
  const archive = path.join(f.packagesDir, `${item.source.zipSha256}.zip`), original = fs.readFileSync(archive);
  fs.unlinkSync(archive); await assert.rejects(installReviewedExtensions(f), /PATH_MISSING/);
  fs.writeFileSync(archive, Buffer.from(original).fill(0)); await assert.rejects(installReviewedExtensions(f), /ARCHIVE_HASH_MISMATCH/);
  fs.writeFileSync(archive, original); item.files.pop(); await assert.rejects(installReviewedExtensions(f), /FILE_MANIFEST_MISMATCH/);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test('package ID or adaptation cannot execute arbitrary script paths', async t => {
  const f = fixture(t); const item = f.add();
  item.id = '../escape'; await assert.rejects(installReviewedExtensions(f), /INVALID_LOCK_ENTRY/);
  item.id = 'fixture-module'; item.adaptation = { script: '../fixture-evil.mjs', scriptSha256: '0'.repeat(64) };
  await assert.rejects(installReviewedExtensions(f), /UNAPPROVED_ADAPTATION/);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test('directory symlinks in live/cache ancestors or source archives are never followed', async t => {
  const f = fixture(t); f.add(); const external = path.join(f.root, 'external'); fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(f.releaseRoot, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installReviewedExtensions(f), /SYMLINK_REJECTED/);
  fs.unlinkSync(path.join(f.releaseRoot, 'skills'));
  fs.symlinkSync(external, f.stateDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installReviewedExtensions(f), /SYMLINK_REJECTED/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('receipt traversal or added files fail the whole rollback before touching any package', async t => {
  const f = fixture(t); const first = f.add('fixture-first'), second = f.add('fixture-second');
  const result = await installReviewedExtensions({ ...f, dryRun: false });
  fs.writeFileSync(path.join(f.releaseRoot, 'skills', second.id, 'new.txt'), 'fixture user addition');
  assert.throws(() => rollbackReviewedExtensions({ receiptFile: result.receipt, dryRun: false }), /FILE_MANIFEST_MISMATCH/);
  assert.equal(fs.existsSync(path.join(f.releaseRoot, 'skills', first.id)), true);
  const receipt = JSON.parse(fs.readFileSync(result.receipt)); receipt.entries[0].id = '../outside'; fs.writeFileSync(result.receipt, JSON.stringify(receipt));
  assert.throws(() => rollbackReviewedExtensions({ receiptFile: result.receipt, dryRun: false }), /INVALID_RECEIPT_ENTRY/);
  assert.equal(fs.existsSync(path.join(f.releaseRoot, 'skills', first.id)), true);
});

test('unknown selection, overlapping private state and a stale transaction lock refuse safely', async t => {
  const f = fixture(t); f.add();
  await assert.rejects(installReviewedExtensions({ ...f, ids: ['unreviewed'] }), /UNKNOWN_EXTENSION/);
  await assert.rejects(installReviewedExtensions({ ...f, stateDir: path.join(f.releaseRoot, 'state') }), /STATE_RELEASE_OVERLAP/);
  fs.mkdirSync(f.stateDir); fs.writeFileSync(path.join(f.stateDir, '.install.lock'), 'fixture lock');
  await assert.rejects(installReviewedExtensions({ ...f, dryRun: false }), { code: 'EEXIST' });
  assert.deepEqual(fs.readdirSync(f.releaseRoot), []);
});
