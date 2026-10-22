import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WEATHER_PATCH, verifyWeatherArchive, patchWeatherSource, patchWeatherEntry } from '../scripts/extensions/weather-compat.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = process.env.QQ_AGENT_EXTENSION_CACHE || path.join(repo, '.local/market-review-2026-10-23');
const zipFile = path.join(cache, 'skills-my-weather.zip');
const available = fs.existsSync(zipFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-weather-overlay-'));
fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
const digest = source => crypto.createHash('sha256').update(source).digest('hex');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function entry(bytes, suffix) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  assert.ok(end >= 0);
  let pos = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt32LE(pos), 0x02014b50);
    const len = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32);
    const name = bytes.subarray(pos + 46, pos + 46 + len).toString();
    if (name === suffix) {
      const local = bytes.readUInt32LE(pos + 42), start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(pos + 20));
      return (bytes.readUInt16LE(pos + 10) === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: 200000 }) : compressed).toString('utf8');
    }
    pos += 46 + len + extra + comment;
  }
  throw Error('Reviewed package fixture entry missing');
}

test('weather overlay rejects arbitrary ZIPs and source text without executing them', () => {
  assert.throws(() => verifyWeatherArchive(Buffer.from('unreviewed archive')), e => e.code === 'WEATHER_ARCHIVE_MISMATCH');
  assert.throws(() => patchWeatherSource('export const unreviewed = true;'), e => e.code === 'WEATHER_SOURCE_MISMATCH');
  assert.throws(() => patchWeatherSource(null), e => e.code === 'WEATHER_SOURCE_MISMATCH');
});

test('weather overlay previews, applies atomically, and replays the pinned official package', { skip: !available && 'Cache the pinned official ZIP with QQ_AGENT_EXTENSION_CACHE for integration verification' }, () => {
  const bytes = fs.readFileSync(zipFile); verifyWeatherArchive(bytes);
  const source = entry(bytes, 'my-weather/index.js'), output = patchWeatherSource(source);
  assert.equal(digest(source), WEATHER_PATCH.sourceSha256);
  assert.equal(digest(output), WEATHER_PATCH.installedSha256);
  assert.equal(patchWeatherSource(output), output);
  const file = path.join(root, 'preview-index.js'); fs.writeFileSync(file, source);
  const preview = patchWeatherEntry({ zipFile, entryFile: file });
  assert.equal(preview.dryRun, true); assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(patchWeatherEntry({ zipFile, entryFile: file, dryRun: false }).changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), output);
  assert.equal(patchWeatherEntry({ zipFile, entryFile: file, dryRun: false }).changed, false);
  fs.appendFileSync(file, '\n// unknown local change');
  assert.throws(() => patchWeatherEntry({ zipFile, entryFile: file, dryRun: false }), e => e.code === 'WEATHER_SOURCE_MISMATCH');
});

test('patched official weather tool loads and bounds real HTTP bodies without credentials or QQ sends', { skip: !available && 'Cache the pinned official ZIP with QQ_AGENT_EXTENSION_CACHE for integration verification' }, async t => {
  const bytes = fs.readFileSync(zipFile); verifyWeatherArchive(bytes);
  const skills = path.join(root, 'skills'), dir = path.join(skills, 'my-weather'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), patchWeatherSource(entry(bytes, 'my-weather/index.js')));
  fs.writeFileSync(path.join(dir, 'skill.json'), entry(bytes, 'my-weather/skill.json'));
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const { skillManager } = await import('../src/skills/manager.js');
  const { getTool } = await import('../src/tool-registry.js');
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.api.apiKey = 'fixture-must-never-leave-model-pipeline';
  cfg.skills = { 'my-weather': { timeoutMs: 1000 } }; setRuntimeConfig(cfg);
  let mode = 'normal', requests = 0, redirected = 0;
  const json = JSON.stringify({ nearest_area: [{ areaName: [{ value: 'Fixture City' }] }], current_condition: [{ temp_C: '20', FeelsLikeC: '19', humidity: '50', winddir16Point: 'N', windspeedKmph: '5', precipMM: '0' }], weather: [] });
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/redirected') { redirected++; res.end(json); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
    if (mode === 'slow') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{'); return; }
    if (mode === 'oversize') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(' '.repeat(262145)); return; }
    if (mode === 'declared-oversize') { res.writeHead(200, { 'content-length': '262145' }); res.end(' '.repeat(262145)); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(json);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const nativeFetch = globalThis.fetch, calls = [];
  globalThis.fetch = (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.origin, 'https://wttr.in');
    assert.equal(options.redirect, 'error'); assert.deepEqual(Object.keys(options.headers), ['User-Agent']);
    assert.equal(JSON.stringify(options).includes(cfg.api.apiKey), false);
    calls.push(String(url)); return nativeFetch(`http://127.0.0.1:${server.address().port}/weather`, options);
  };
  t.after(async () => { globalThis.fetch = nativeFetch; skillManager.unregister('my-weather'); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const loaded = await loadPlugins({ log() {}, roots: { skills, plugins: path.join(root, 'missing-plugins') } });
  assert.equal(loaded.failed.length, 0); assert.equal(skillManager.isActive('my-weather').active, true);
  const tool = getTool('my-weather__get_weather'); assert.ok(tool);
  const ctx = { chatKey: 'group:101', onebot: { call() { throw Error('Tool must not directly send QQ'); } } };
  await t.test('encoded city stays on the one approved host and works for group/private calls', async () => {
    const city = '杭州/../?url=http://127.0.0.1#fragment';
    const result = await tool.execute(ctx, { city, days: 0 }); assert.match(result.content, /Fixture City/);
    assert.equal(calls.at(-1), `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`);
    assert.match((await tool.execute({ ...ctx, chatKey: 'private:101' }, { city: '北京', days: 0 })).content, /Fixture City/);
  });
  await t.test('blank, long, nonstring and control-character cities make no request', async () => {
    const before = requests;
    for (const city of ['', 'x'.repeat(101), '北京\n', ['北京']]) assert.equal((await tool.execute(ctx, { city })).isError, true);
    assert.equal(requests, before);
  });
  await t.test('HTTP redirects are rejected without following another destination', async () => {
    mode = 'redirect'; assert.equal((await tool.execute(ctx, { city: '北京' })).isError, true); assert.equal(redirected, 0);
  });
  await t.test('declared and streamed oversized bodies are rejected', async () => {
    for (mode of ['oversize', 'declared-oversize']) assert.match((await tool.execute(ctx, { city: '北京' })).content, /256KB/);
  });
  await t.test('timeout remains active after headers while the body stalls', async () => {
    mode = 'slow'; const started = Date.now(); const result = await tool.execute(ctx, { city: '北京' });
    assert.equal(result.isError, true); assert.match(result.content, /超时/); assert.ok(Date.now() - started < 1800);
  });
  await t.test('an oversized timeout setting is clamped to 8000 ms', async () => {
    mode = 'normal'; cfg.skills['my-weather'].timeoutMs = 9999999; setRuntimeConfig(cfg);
    const nativeTimer = globalThis.setTimeout, delays = [];
    globalThis.setTimeout = (fn, ms, ...args) => { delays.push(ms); return nativeTimer(fn, ms, ...args); };
    try { assert.match((await tool.execute(ctx, { city: '北京' })).content, /Fixture City/); }
    finally { globalThis.setTimeout = nativeTimer; }
    assert.ok(delays.includes(8000)); assert.equal(delays.includes(9999999), false);
  });
});
