// Offline, exact-lock installation. This deliberately does not execute packages,
// edit application configuration, fetch URLs, or reload a running application.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ZIP = 8 * 1024 * 1024;
const MAX_EXPANDED = 8 * 1024 * 1024;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const safeHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root, target) => target === root || (path.relative(root, target) !== '' && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target)));
const existsAny = value => { try { fs.lstatSync(value); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } };

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.endsWith('/')) fail('UNSAFE_RELATIVE_PATH');
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) fail('UNSAFE_RELATIVE_PATH');
  return value;
}

// Reject symlinks at every existing ancestor, rather than resolving through them.
function noLinks(value, { directory = false, create = false, mode = 0o700 } = {}) {
  if (!path.isAbsolute(value)) fail('ABSOLUTE_PATH_REQUIRED');
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) fail('PATH_MISSING');
      fs.mkdirSync(cursor, { mode });
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink()) fail('SYMLINK_REJECTED');
    if (cursor !== absolute && !stat.isDirectory()) fail('PARENT_NOT_DIRECTORY');
  }
  const stat = fs.lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !(stat.isDirectory() || stat.isFile())) fail('UNSUPPORTED_FILE_TYPE');
  return absolute;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Strict small ZIP reader: no shell extraction, descriptors, ZIP64 or links. */
export function readReviewedZip(buffer, moduleRoot) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ZIP || !safeId(moduleRoot)) fail('INVALID_ARCHIVE');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) fail('INVALID_ZIP_DIRECTORY');
  const count = buffer.readUInt16LE(end + 10);
  const length = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (!count || count > 128 || count !== buffer.readUInt16LE(end + 8) || start + length !== end) fail('INVALID_ZIP_DIRECTORY');
  const files = new Map(), names = new Set(), ranges = [];
  let at = start, expanded = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) fail('INVALID_ZIP_ENTRY');
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30), commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42), attr = buffer.readUInt32LE(at + 38), unixType = (attr >>> 16) & 0xf000;
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end || buffer.readUInt16LE(at + 34) || (flags & ~0x800) || ![0, 8].includes(method) || ![0, 0x8000, 0x4000].includes(unixType)) fail('UNSUPPORTED_ZIP_ENTRY');
    const nameBytes = buffer.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const directory = name.endsWith('/');
    const normalized = safeRelative(directory ? name.slice(0, -1) : name);
    if (names.has(normalized.toLowerCase())) fail('DUPLICATE_ZIP_PATH');
    names.add(normalized.toLowerCase());
    if (normalized !== moduleRoot && !normalized.startsWith(`${moduleRoot}/`)) fail('MODULE_ROOT_MISMATCH');
    if (localAt + 30 > start || buffer.readUInt32LE(localAt) !== 0x04034b50) fail('INVALID_LOCAL_HEADER');
    const ln = buffer.readUInt16LE(localAt + 26), le = buffer.readUInt16LE(localAt + 28);
    const payloadAt = localAt + 30 + ln + le, payloadEnd = payloadAt + compressed;
    if (payloadEnd > start || !buffer.subarray(localAt + 30, localAt + 30 + ln).equals(nameBytes) || buffer.readUInt16LE(localAt + 6) !== flags || buffer.readUInt16LE(localAt + 8) !== method || buffer.readUInt32LE(localAt + 14) !== crc || buffer.readUInt32LE(localAt + 18) !== compressed || buffer.readUInt32LE(localAt + 22) !== size) fail('ZIP_HEADER_MISMATCH');
    if (ranges.some(([a, b]) => localAt < b && payloadEnd > a)) fail('ZIP_ENTRY_OVERLAP');
    ranges.push([localAt, payloadEnd]);
    if (size > MAX_EXPANDED || expanded + size > MAX_EXPANDED) fail('ARCHIVE_EXPANSION_LIMIT');
    let data;
    try { data = method === 0 ? buffer.subarray(payloadAt, payloadEnd) : inflateRawSync(buffer.subarray(payloadAt, payloadEnd), { maxOutputLength: Math.max(1, size) }); }
    catch { fail('INVALID_COMPRESSED_DATA'); }
    if (data.length !== size || crc32(data) !== crc || (directory && size !== 0)) fail('ZIP_CONTENT_MISMATCH');
    expanded += size;
    if (!directory) {
      if (normalized === moduleRoot) fail('MODULE_ROOT_NOT_DIRECTORY');
      files.set(normalized.slice(moduleRoot.length + 1), Buffer.from(data));
    }
    at = next;
  }
  if (at !== end || !files.size) fail('INVALID_ZIP_DIRECTORY');
  return files;
}

function validateFiles(files, expected) {
  if (!Array.isArray(expected) || !expected.length || expected.length > 128 || files.size !== expected.length) fail('FILE_MANIFEST_MISMATCH');
  const seen = new Set();
  for (const item of expected) {
    if (!record(item)) fail('INVALID_FILE_MANIFEST');
    const relative = safeRelative(item.path);
    if (seen.has(relative.toLowerCase()) || !safeHash(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) fail('INVALID_FILE_MANIFEST');
    seen.add(relative.toLowerCase());
    const data = files.get(relative);
    if (!data || data.length !== item.bytes || digest(data) !== item.sha256) fail('FILE_HASH_MISMATCH');
  }
}

function readInstalled(target) {
  noLinks(target, { directory: true });
  const files = new Map();
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeRelative(name);
      if (entry.isSymbolicLink()) fail('SYMLINK_REJECTED');
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name);
      else if (entry.isFile()) {
        const stat = fs.statSync(path.join(directory, entry.name));
        if (stat.size > MAX_EXPANDED || files.size >= 128) fail('INSTALLED_SIZE_LIMIT');
        files.set(name, fs.readFileSync(path.join(directory, entry.name)));
      } else fail('UNSUPPORTED_FILE_TYPE');
    }
  }
  visit(target);
  return files;
}

function validateLock(lock) {
  if (!record(lock) || lock.format !== 'qq-agent-extension-lock' || lock.version !== 1 || !Array.isArray(lock.extensions) || lock.extensions.length > 32) fail('INVALID_LOCK');
  const ids = new Set();
  for (const item of lock.extensions) {
    if (!record(item) || !safeId(item.id) || ids.has(item.id) || !['skill', 'plugin'].includes(item.kind) || !safeId(item.moduleRoot) || typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(item.version)) fail('INVALID_LOCK_ENTRY');
    if (!record(item.source) || !safeHash(item.source.zipSha256) || !Number.isSafeInteger(item.source.zipBytes) || item.source.zipBytes < 22 || item.source.zipBytes > MAX_ZIP) fail('INVALID_LOCK_SOURCE');
    if (item.manifest !== (item.kind === 'skill' ? 'skill.json' : 'plugin.json')) fail('INVALID_MODULE_MANIFEST');
    if (!record(item.defaults) || typeof item.defaults.enabled !== 'boolean' || !record(item.defaults.settings)) fail('INVALID_DEFAULTS');
    ids.add(item.id);
  }
}

async function prepare(item, packagesDir) {
  const archive = path.join(packagesDir, `${item.source.zipSha256}.zip`);
  noLinks(archive);
  const stat = fs.statSync(archive);
  if (!stat.isFile() || stat.size !== item.source.zipBytes) fail('ARCHIVE_SIZE_MISMATCH');
  const zip = fs.readFileSync(archive);
  if (digest(zip) !== item.source.zipSha256) fail('ARCHIVE_HASH_MISMATCH');
  const files = readReviewedZip(zip, item.moduleRoot);
  validateFiles(files, item.sourceFiles || item.files);
  if (item.adaptation) {
    const patches = {
      'scripts/extensions/weather-compat.mjs': 'patchWeatherSource',
      'scripts/extensions/meal-compat.mjs': 'patchMealSource'
    };
    const adaptation = item.adaptation, fn = patches[adaptation.script];
    if (!fn || !safeHash(adaptation.scriptSha256)) fail('UNAPPROVED_ADAPTATION');
    const script = path.join(REPO, adaptation.script);
    noLinks(script);
    if (digest(fs.readFileSync(script)) !== adaptation.scriptSha256) fail('ADAPTATION_HASH_MISMATCH');
    const entry = files.get('index.js');
    if (!entry || digest(entry) !== adaptation.sourceEntrySha256) fail('ADAPTATION_SOURCE_MISMATCH');
    const helper = await import(pathToFileURL(script));
    const result = Buffer.from(helper[fn](new TextDecoder('utf-8', { fatal: true }).decode(entry)), 'utf8');
    if (digest(result) !== adaptation.installedEntrySha256) fail('ADAPTATION_OUTPUT_MISMATCH');
    files.set('index.js', result);
  }
  validateFiles(files, item.files);
  let manifest;
  try { manifest = JSON.parse(files.get(item.manifest).toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('INVALID_MODULE_MANIFEST'); }
  if (manifest.id !== item.id || manifest.version !== item.version || manifest.apiVersion !== 1) fail('MODULE_IDENTITY_MISMATCH');
  safeRelative(manifest.entry || 'index.js');
  if (!files.has(manifest.entry || 'index.js')) fail('MODULE_ENTRY_MISSING');
  return { item, zip, files };
}

/** No URLs are fetched. Supply each original ZIP as <sha256>.zip. */
export async function installReviewedExtensions({ lock, packagesDir, releaseRoot, stateDir, ids = null, dryRun = true } = {}) {
  validateLock(lock);
  releaseRoot = noLinks(releaseRoot, { directory: true });
  packagesDir = noLinks(packagesDir, { directory: true });
  if (!path.isAbsolute(stateDir)) fail('ABSOLUTE_PATH_REQUIRED');
  stateDir = path.resolve(stateDir);
  if (inside(releaseRoot, stateDir) || inside(stateDir, releaseRoot)) fail('STATE_RELEASE_OVERLAP');
  // Validate existing ancestors even for a non-mutating preview.
  let ancestor = stateDir;
  while (!existsAny(ancestor)) ancestor = path.dirname(ancestor);
  noLinks(ancestor, { directory: true });
  if (ids && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !lock.extensions.some(item => item.id === id)))) fail('UNKNOWN_EXTENSION');
  const selected = lock.extensions.filter(item => !ids || ids.includes(item.id));
  if (!selected.length) fail('EMPTY_SELECTION');
  const prepared = [];
  for (const item of selected) {
    const value = await prepare(item, packagesDir);
    const parent = path.join(releaseRoot, item.kind === 'skill' ? 'skills' : 'plugins');
    if (existsAny(parent)) noLinks(parent, { directory: true });
    const target = path.join(parent, item.id);
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) validateFiles(readInstalled(target), item.files);
    prepared.push({ ...value, parent, target, exists });
  }
  const summary = { ok: true, dryRun, packages: prepared.map(({ item, exists }) => ({ id: item.id, kind: item.kind, version: item.version, status: exists ? 'unchanged' : 'new', files: item.files.length, enabledDefault: item.defaults.enabled })), receipt: null, reloadRequired: false };
  if (dryRun) return summary;
  noLinks(stateDir, { directory: true, create: true });
  const mutex = path.join(stateDir, '.install.lock');
  const handle = fs.openSync(mutex, 'wx', 0o600);
  const nonce = crypto.randomUUID();
  const receiptPath = path.join(stateDir, `install-${nonce}.json`);
  const receipt = { format: 'qq-agent-extension-install', version: 1, releaseRoot, createdAt: new Date().toISOString(), lockSha256: digest(Buffer.from(JSON.stringify(lock))), entries: [], complete: false };
  const stages = [], installed = [];
  const saveReceipt = () => {
    const temporary = `${receiptPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, receiptPath);
  };
  try {
    const cache = noLinks(path.join(stateDir, 'cache'), { directory: true, create: true });
    for (const value of prepared) {
      const { item, zip, files, target, parent, exists } = value;
      const cached = path.join(cache, `${item.source.zipSha256}.zip`);
      if (fs.existsSync(cached)) { noLinks(cached); if (digest(fs.readFileSync(cached)) !== item.source.zipSha256) fail('CACHE_HASH_MISMATCH'); }
      else fs.writeFileSync(cached, zip, { flag: 'wx', mode: 0o600 });
      if (exists) continue;
      noLinks(parent, { directory: true, create: true, mode: 0o755 });
      // Outside loader roots: an unrelated reload cannot import a half-built dir.
      const stage = path.join(releaseRoot, `.reviewed-${nonce}-${item.id}`);
      fs.mkdirSync(stage, { mode: 0o755 }); stages.push(stage);
      for (const [relative, data] of files) {
        const output = path.join(stage, relative);
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
        fs.writeFileSync(output, data, { flag: 'wx', mode: 0o644 });
      }
      validateFiles(readInstalled(stage), item.files);
      if (fs.existsSync(target)) fail('TARGET_APPEARED');
      receipt.entries.push({ id: item.id, kind: item.kind, files: item.files });
      saveReceipt(); // Recovery identity exists before the directory becomes live.
      fs.renameSync(stage, target); installed.push(value);
    }
    receipt.complete = true; saveReceipt();
    summary.receipt = receiptPath;
    summary.reloadRequired = installed.length > 0;
    return summary;
  } catch (error) {
    for (const { target, item } of installed.reverse()) {
      validateFiles(readInstalled(target), item.files);
      if (!inside(releaseRoot, target)) fail('ROLLBACK_OUTSIDE_RELEASE');
      fs.rmSync(target, { recursive: true });
    }
    receipt.failed = true; saveReceipt();
    throw error;
  } finally {
    for (const stage of stages) if (fs.existsSync(stage)) { noLinks(stage, { directory: true }); if (!inside(releaseRoot, stage)) fail('STAGE_OUTSIDE_RELEASE'); fs.rmSync(stage, { recursive: true }); }
    fs.closeSync(handle); fs.unlinkSync(mutex);
  }
}

/** Refuse rollback if another actor has changed a package since installation. */
export function rollbackReviewedExtensions({ receiptFile, dryRun = true } = {}) {
  noLinks(receiptFile);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt.format !== 'qq-agent-extension-install' || receipt.version !== 1 || !Array.isArray(receipt.entries) || receipt.entries.length > 32) fail('INVALID_RECEIPT');
  const root = noLinks(receipt.releaseRoot, { directory: true });
  const targets = [], seen = new Set();
  for (const entry of receipt.entries) {
    if (!safeId(entry.id) || !['skill', 'plugin'].includes(entry.kind) || seen.has(entry.id)) fail('INVALID_RECEIPT_ENTRY');
    seen.add(entry.id);
    const target = path.join(root, entry.kind === 'skill' ? 'skills' : 'plugins', entry.id);
    if (!inside(root, target)) fail('ROLLBACK_OUTSIDE_RELEASE');
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) { validateFiles(readInstalled(target), entry.files); targets.push(target); }
  }
  if (!dryRun) for (const target of targets) { noLinks(target, { directory: true }); if (!inside(root, target)) fail('ROLLBACK_OUTSIDE_RELEASE'); fs.rmSync(target, { recursive: true }); }
  return { ok: true, dryRun, removed: dryRun ? 0 : targets.length, eligible: targets.length, reloadRequired: !dryRun && targets.length > 0 };
}

async function main() {
  const args = process.argv.slice(2), options = {}, ids = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') { options.apply = true; continue; }
    if (!['--lock', '--packages-dir', '--release-root', '--state-dir', '--id', '--rollback'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENT');
    const value = args[++i];
    if (key === '--id') ids.push(value); else { if (options[key]) fail('DUPLICATE_ARGUMENT'); options[key] = value; }
  }
  if (options['--rollback']) {
    if (Object.keys(options).some(key => !['apply', '--rollback'].includes(key)) || ids.length) fail('INVALID_ARGUMENT');
    console.log(JSON.stringify(rollbackReviewedExtensions({ receiptFile: options['--rollback'], dryRun: !options.apply })));
  } else {
    const lockFile = noLinks(options['--lock'] || '');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    console.log(JSON.stringify(await installReviewedExtensions({ lock, packagesDir: options['--packages-dir'], releaseRoot: options['--release-root'], stateDir: options['--state-dir'], ids: ids.length ? ids : null, dryRun: !options.apply })));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'INSTALL_FAILED' })); process.exitCode = 1; });
}
