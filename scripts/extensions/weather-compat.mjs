// Installation-time compatibility overlay for the reviewed official package.
// This repository does not redistribute the third-party package itself.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const WEATHER_PATCH = Object.freeze({
  id: 'my-weather-body-bound-v1',
  version: '1.0.0',
  archiveSha256: '4117210c0f09611683c5b67ca12923f3f1860b0eacbf6d09169737c5da4a7262',
  sourceSha256: 'b8f6199006adedac45931f66f5e58877a67f72f247debf8d5014a6fead2e497b',
  installedSha256: '6d033fbdaae31bfaaa3efba7b7bb86987283798d2fddc2a121ac62a0678c4ab5',
  maxBodyBytes: 262144,
  maxTimeoutMs: 8000
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

export function verifyWeatherArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024 || sha(bytes) !== WEATHER_PATCH.archiveSha256) throw fail('WEATHER_ARCHIVE_MISMATCH');
  return WEATHER_PATCH.archiveSha256;
}

const boundedReader = String.raw`
// QQ Agent platform installation overlay: my-weather-body-bound-v1.
// Bound the complete response; this is separate from the model's paid guard.
async function readBoundedWeatherJson(response, signal) {
  const limit = 256 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error('天气响应超过 256KB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('天气服务响应为空');
  const chunks = [];
  let bytes = 0;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(Object.assign(new Error('天气查询超时'), { name: 'AbortError' }));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('天气响应超过 256KB');
      chunks.push(Buffer.from(part.value));
    }
    if (signal.aborted) throw Object.assign(new Error('天气查询超时'), { name: 'AbortError' });
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* A cancelled read may still be finishing. */ }
  }
}
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw fail('WEATHER_SOURCE_LAYOUT_MISMATCH');
  return source.replace(before, after);
}

export function patchWeatherSource(source) {
  if (typeof source !== 'string') throw fail('WEATHER_SOURCE_MISMATCH');
  const beforeHash = sha(source);
  if (beforeHash === WEATHER_PATCH.installedSha256) return source;
  if (beforeHash !== WEATHER_PATCH.sourceSha256) throw fail('WEATHER_SOURCE_MISMATCH');
  let result = replaceOnce(source,
    "      const city = String(args?.city ?? '').trim();\n      if (!city) return fail('没有拿到城市名：让对方说明查哪个城市，再放进 city。');",
    String.raw`      const rawCity = typeof args?.city === 'string' ? args.city : '';
      const city = rawCity.trim();
      if (!city || city.length > 100 || /[\x00-\x1f\x7f]/.test(rawCity)) {
        return fail('请提供不超过 100 字的城市名，不要包含控制字符。');
      }`);
  result = replaceOnce(result,
    '      const timeoutMs = Math.max(3000, Number(c.timeoutMs) || 8000);',
    '      const timeoutMs = Math.max(1000, Math.min(8000, Number(c.timeoutMs) || 8000));');
  result = replaceOnce(result,
    '            signal: ac.signal,',
    "            signal: ac.signal,\n            redirect: 'error',");
  result = replaceOnce(result,
    `        } finally {
          clearTimeout(timer);
        }

        if (resp.status === 400 || resp.status === 404) {
          return fail(\`没找到「\${city}」这个城市：让对方确认城市名，或换个附近的大城市再查。\`);
        }
        if (!resp.ok) return fail(\`天气服务暂时不可用（HTTP \${resp.status}），稍后再试。\`);

        const data = await resp.json();
        return { content: render(data, { city, days }) };`,
    `          if (resp.status === 400 || resp.status === 404) {
            void resp.body?.cancel().catch(() => {});
            return fail(\`没找到「\${city}」这个城市：让对方确认城市名，或换个附近的大城市再查。\`);
          }
          if (!resp.ok) {
            void resp.body?.cancel().catch(() => {});
            return fail(\`天气服务暂时不可用（HTTP \${resp.status}），稍后再试。\`);
          }
          const data = await readBoundedWeatherJson(resp, ac.signal);
          return { content: render(data, { city, days }) };
        } finally {
          clearTimeout(timer);
        }`);
  result += boundedReader;
  if (sha(result) !== WEATHER_PATCH.installedSha256) throw fail('WEATHER_PATCH_OUTPUT_MISMATCH');
  return result;
}

function readRegular(file, maxBytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('ABSOLUTE_WEATHER_PATH_REQUIRED');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw fail('WEATHER_FILE_INVALID');
  return { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

export function patchWeatherEntry({ zipFile, entryFile, dryRun = true } = {}) {
  if (typeof dryRun !== 'boolean') throw fail('WEATHER_DRY_RUN_INVALID');
  verifyWeatherArchive(readRegular(zipFile, 8 * 1024 * 1024).bytes);
  const original = readRegular(entryFile, 128 * 1024);
  const source = original.bytes.toString('utf8');
  if (!original.bytes.equals(Buffer.from(source))) throw fail('WEATHER_SOURCE_ENCODING_INVALID');
  const patched = patchWeatherSource(source), installedSha256 = sha(patched), changed = patched !== source;
  if (!dryRun && changed) {
    const temp = path.join(path.dirname(entryFile), '.weather-patch-' + crypto.randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, patched, { flag: 'wx', mode: original.mode });
      if (!readRegular(entryFile, 128 * 1024).bytes.equals(original.bytes)) throw fail('WEATHER_ENTRY_CHANGED');
      fs.renameSync(temp, entryFile);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { patchId: WEATHER_PATCH.id, dryRun, changed, archiveSha256: WEATHER_PATCH.archiveSha256, sourceSha256: WEATHER_PATCH.sourceSha256, installedSha256 };
}

function main(argv) {
  const options = { dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') { if (!options.dryRun) throw fail('WEATHER_ARGUMENTS_INVALID'); options.dryRun = false; continue; }
    const key = { '--zip': 'zipFile', '--entry': 'entryFile' }[argv[i]];
    if (!key || !argv[i + 1] || options[key]) throw fail('WEATHER_ARGUMENTS_INVALID');
    options[key] = argv[++i];
  }
  process.stdout.write(JSON.stringify({ ok: true, ...patchWeatherEntry(options) }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'WEATHER_PATCH_FAILED' }) + '\n'); process.exitCode = 1; }
}
