// Installation-time scope compatibility overlay; no third-party source bundled.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MEAL_PATCH = Object.freeze({
  id: 'meal-picker-chat-scope-v1',
  version: '1.0.0',
  archiveSha256: 'a4c769f2e825589ead04f42bfad4c9ab77138a55f46e2c54a08e10d0d624a84d',
  sourceSha256: '53fa118279ed72442f093735426f9e83775c8ef730d587b3736d1bf5e05b8920',
  installedSha256: 'a1359c10e80e02117514427d3015657503898327c796366c782d544279eaf30b'
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

export function verifyMealArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024 || sha(bytes) !== MEAL_PATCH.archiveSha256) throw fail('MEAL_ARCHIVE_MISMATCH');
  return MEAL_PATCH.archiveSha256;
}

export function patchMealSource(source) {
  if (typeof source !== 'string') throw fail('MEAL_SOURCE_MISMATCH');
  const beforeHash = sha(source);
  if (beforeHash === MEAL_PATCH.installedSha256) return source;
  if (beforeHash !== MEAL_PATCH.sourceSha256) throw fail('MEAL_SOURCE_MISMATCH');
  const before = '        const quota = consumeOnce(userId, meal, limit);';
  const after = String.raw`        // QQ Agent platform installation overlay: meal-picker-chat-scope-v1.
        // A person's usage in another group/private chat must remain private.
        if (typeof ctx?.chatKey !== 'string' || !/^(group|private):[1-9]\d*$/.test(ctx.chatKey)) {
          return { content: '缺少可信的聊天范围，无法记录本次推荐。', isError: true };
        }
        const quotaIdentity = JSON.stringify([ctx.chatKey, userId]);
        const quota = consumeOnce(quotaIdentity, meal, limit);`;
  if (source.split(before).length !== 2) throw fail('MEAL_SOURCE_LAYOUT_MISMATCH');
  const result = source.replace(before, after);
  if (sha(result) !== MEAL_PATCH.installedSha256) throw fail('MEAL_PATCH_OUTPUT_MISMATCH');
  return result;
}

function readRegular(file, maxBytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('ABSOLUTE_MEAL_PATH_REQUIRED');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw fail('MEAL_FILE_INVALID');
  return { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

export function patchMealEntry({ zipFile, entryFile, dryRun = true } = {}) {
  if (typeof dryRun !== 'boolean') throw fail('MEAL_DRY_RUN_INVALID');
  verifyMealArchive(readRegular(zipFile, 8 * 1024 * 1024).bytes);
  const original = readRegular(entryFile, 128 * 1024), source = original.bytes.toString('utf8');
  if (!original.bytes.equals(Buffer.from(source))) throw fail('MEAL_SOURCE_ENCODING_INVALID');
  const patched = patchMealSource(source), installedSha256 = sha(patched), changed = patched !== source;
  if (!dryRun && changed) {
    const temp = path.join(path.dirname(entryFile), '.meal-patch-' + crypto.randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, patched, { flag: 'wx', mode: original.mode });
      if (!readRegular(entryFile, 128 * 1024).bytes.equals(original.bytes)) throw fail('MEAL_ENTRY_CHANGED');
      fs.renameSync(temp, entryFile);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { patchId: MEAL_PATCH.id, dryRun, changed, archiveSha256: MEAL_PATCH.archiveSha256, sourceSha256: MEAL_PATCH.sourceSha256, installedSha256 };
}

function main(argv) {
  const options = { dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') { if (!options.dryRun) throw fail('MEAL_ARGUMENTS_INVALID'); options.dryRun = false; continue; }
    const key = { '--zip': 'zipFile', '--entry': 'entryFile' }[argv[i]];
    if (!key || !argv[i + 1] || options[key]) throw fail('MEAL_ARGUMENTS_INVALID');
    options[key] = argv[++i];
  }
  process.stdout.write(JSON.stringify({ ok: true, ...patchMealEntry(options) }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'MEAL_PATCH_FAILED' }) + '\n'); process.exitCode = 1; }
}
