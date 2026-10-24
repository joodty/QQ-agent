#!/usr/bin/env node
// Private Linux broker for isolated SnowLuma + QQ Agent instances. No Bridge/DSH.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const execFile = promisify(callbackExecFile);
const fail = code => Object.assign(new Error(code), { code });
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const qq = value => typeof value === 'string' && /^[1-9]\d{4,14}$/.test(value) && Number.isSafeInteger(Number(value));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const APP_ID = 0x51504853;

export function validateHostedQQAgentConfig(config, { injectedRuntime = false } = {}) {
  if (!config || !path.isAbsolute(config.root || '') || !/^[A-Za-z0-9_-]{32,128}$/.test(config.secret || '')
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
      || !Number.isInteger(config.maxBots) || config.maxBots < 1 || config.maxBots > 16
      || !Number.isInteger(config.basePort) || config.basePort < 10000 || config.basePort + config.maxBots * 10 > 65535) throw Error('Invalid private hosted QQ service configuration');
  if (!injectedRuntime) {
    for (const key of ['codeRoot', 'dockerBin', 'dockerSocket', 'startScript', 'slirpBin', 'slirpLib', 'nsenterBin', 'ipBin']) if (!path.isAbsolute(config[key] || '')) throw Error('Invalid hosted runtime path: ' + key);
    for (const key of ['image', 'agentImage']) if (!/^\S+@sha256:[a-f0-9]{64}$/.test(config[key] || '')) throw Error('Hosted container images must be pinned by digest');
    if (!Number.isInteger(config.uidBase) || config.uidBase < 10000 || config.uidBase > 2000000000
        || !Number.isInteger(config.gidBase) || config.gidBase < 10000 || config.gidBase > 2000000000) throw Error('Invalid hosted OS identity range');
    const root = path.resolve(config.root), code = path.resolve(config.codeRoot);
    if (root === code || root.startsWith(code + path.sep) || code.startsWith(root + path.sep)) throw Error('Hosted runtime and read-only release must be separate');
  }
  return config;
}

/** Test injection supplies the same start/inspect/stop/refresh methods as Docker.
 * SQL persists credentials and reservations before any runtime side effect. */
export function createHostedQQAgentService(config, { runtime: injectedRuntime, now = Date.now } = {}) {
  validateHostedQQAgentConfig(config, { injectedRuntime: Boolean(injectedRuntime) });
  fs.mkdirSync(config.root, { recursive: true, mode: 0o711 });
  const dbFile = path.join(config.root, 'hosted-runtime.sqlite'), db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout=5000;');
  const application = db.prepare('PRAGMA application_id').get().application_id, schema = db.prepare('PRAGMA user_version').get().user_version;
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (!(application === 0 && schema === 0 && tables.length === 0) && (application !== APP_ID || schema !== 1 || !tables.some(row => row.name === 'runtime_instances'))) { db.close(); throw Error('Hosted runtime database unsupported; refusing overwrite'); }
  if (process.platform !== 'win32') fs.chmodSync(dbFile, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_instances (
    request_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, expected_qq TEXT NOT NULL, slot INTEGER NOT NULL,
    identity_index INTEGER NOT NULL UNIQUE, version INTEGER NOT NULL, state TEXT NOT NULL, reserved INTEGER NOT NULL,
    machine_token TEXT NOT NULL, onebot_token TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER NOT NULL, qr_at INTEGER NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_live_slot ON runtime_instances(slot) WHERE reserved=1;
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_live_qq ON runtime_instances(expected_qq) WHERE reserved=1;
  PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; PRAGMA journal_mode=WAL;`);
  const runtime = injectedRuntime || createDockerQQAgentRuntime(config, { now });
  const locks = new Set(); let creating = false, closing = false;
  const get = id => db.prepare('SELECT * FROM runtime_instances WHERE request_id=?').get(id);
  const saveState = (row, state, reserved = 1) => { db.prepare('UPDATE runtime_instances SET state=?,reserved=? WHERE request_id=?').run(state, reserved, row.request_id); row.state = state; row.reserved = reserved; };
  const connection = row => ({ botId: 'hosted-' + row.request_id, expectedQQ: row.expected_qq, port: config.basePort + row.slot * 10 + 2, machineToken: row.machine_token });
  async function stop(row, target = 'stopped') {
    saveState(row, 'cleanup_pending');
    await runtime.stop(row);
    saveState(row, target, target === 'mismatch' ? 1 : 0);
  }
  async function inspect(row) {
    if (['stopped', 'mismatch', 'cleanup_pending', 'failed'].includes(row.state)) return { state: row.state };
    const live = await runtime.inspect(row);
    if (live.actualQQ) {
      if (String(live.actualQQ) !== row.expected_qq) { await stop(row, 'mismatch'); return { state: 'mismatch' }; }
      const state = live.online === true && live.agentReady === true ? 'ready' : 'connecting';
      saveState(row, state); return { state };
    }
    if (row.state === 'ready' || row.state === 'connecting') {
      // An offline process cannot retain ready status. A live wrong account is
      // handled above, before any image or Agent activation is returned.
      saveState(row, 'connecting'); return { state: 'connecting' };
    }
    const expiresAt = row.qr_at + 120000;
    if (now() >= expiresAt) { saveState(row, 'expired'); return { state: 'expired' }; }
    if (typeof live.qrImage === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(live.qrImage) && live.qrImage.length < 2 * 1024 * 1024) {
      saveState(row, 'waiting_scan'); return { state: 'waiting_scan', qrImage: live.qrImage, expiresAt };
    }
    saveState(row, 'starting'); return { state: 'starting' };
  }
  async function operation(action, input) {
    if (closing || !['start', 'status', 'refresh', 'reconnect', 'cancel'].includes(action)
        || !exact(input, ['requestId', 'ownerUserId', 'expectedQQ', 'slot', 'version']) || !requestId(input.requestId) || !requestId(input.ownerUserId)
        || !qq(input.expectedQQ) || !Number.isInteger(input.slot) || input.slot < 0 || input.slot >= config.maxBots || !Number.isSafeInteger(input.version) || input.version < 1) throw fail('INVALID');
    if (locks.has(input.requestId)) throw fail('BUSY');
    locks.add(input.requestId);
    let row;
    try {
      row = get(input.requestId);
      if (row && (row.owner_user_id !== input.ownerUserId || row.expected_qq !== input.expectedQQ || input.version < row.version
          || row.slot !== input.slot && !(['start', 'reconnect'].includes(action) && row.state === 'stopped'))) throw fail('CONFLICT');
      if (!row && action === 'cancel') return { ok: true, login: { state: 'stopped' } };
      if (!row && !['start', 'reconnect'].includes(action)) throw fail('MISSING');
      if (['start', 'reconnect'].includes(action)) {
        if (creating) throw fail('BUSY'); creating = true;
        try {
          if (row?.state === 'mismatch') throw fail('CONFLICT');
          if (row?.state === 'cleanup_pending') throw fail('BUSY');
          if (action === 'reconnect' && row?.reserved) await stop(row);
          if (!row || !row.reserved) {
            if (row?.started_at && now() - row.started_at < (config.cooldownMs ?? 30000)) throw fail('BUSY');
            const free = db.prepare('SELECT COUNT(*) AS n FROM runtime_instances WHERE reserved=1').get().n;
            if (free >= config.maxBots) throw fail('CAPACITY');
            if (db.prepare('SELECT 1 FROM runtime_instances WHERE reserved=1 AND (slot=? OR expected_qq=?)').get(input.slot, input.expectedQQ)) throw fail('CONFLICT');
            if (runtime.capacity && !await runtime.capacity()) throw fail('RESOURCE');
            if (!row) {
              const identityIndex = db.prepare('SELECT COALESCE(MAX(identity_index),-1)+1 AS n FROM runtime_instances').get().n;
              if (identityIndex >= 10000) throw fail('CAPACITY');
              db.prepare('INSERT INTO runtime_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.requestId, input.ownerUserId, input.expectedQQ, input.slot, identityIndex, input.version, 'starting', 1,
                crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('base64url'), now(), now(), now());
            } else db.prepare("UPDATE runtime_instances SET state='starting',reserved=1,slot=?,version=?,started_at=?,qr_at=? WHERE request_id=?").run(input.slot, input.version, now(), now(), row.request_id);
            row = get(input.requestId);
          }
          db.prepare('UPDATE runtime_instances SET version=? WHERE request_id=?').run(input.version, row.request_id);
          try { await runtime.start(row); }
          catch (error) { try { await stop(row); } catch { saveState(row, 'cleanup_pending'); } throw error; }
        } finally { creating = false; }
      } else db.prepare('UPDATE runtime_instances SET version=? WHERE request_id=?').run(input.version, row.request_id);
      if (action === 'cancel') { await stop(row); return { ok: true, login: { state: 'stopped' } }; }
      if (action === 'refresh') {
        if (['stopped', 'mismatch', 'cleanup_pending'].includes(row.state)) throw fail('CONFLICT');
        const before = await inspect(row);
        if (!['ready', 'connecting', 'mismatch'].includes(before.state)) {
          if (now() - row.qr_at < (config.refreshCooldownMs ?? 5000)) throw fail('BUSY');
          await runtime.refresh(row); row.qr_at = now();
          db.prepare("UPDATE runtime_instances SET qr_at=?,state='starting' WHERE request_id=?").run(row.qr_at, row.request_id); row.state = 'starting';
        }
      }
      return { ok: true, login: await inspect(row), connection: connection(row) };
    } finally { locks.delete(input.requestId); }
  }
  async function recover() {
    // A durable cleanup intent is finished before its capacity is released.
    for (const row of db.prepare('SELECT * FROM runtime_instances WHERE reserved=1').all()) {
      if (locks.has(row.request_id)) continue;
      locks.add(row.request_id);
      try {
        if (row.state === 'cleanup_pending') await stop(row);
        else if (row.state !== 'mismatch') { await runtime.start(row); await inspect(row); }
      } catch { /* Retain reservation and report actual status on the next poll. */ }
      finally { locks.delete(row.request_id); }
    }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
    const supplied = Buffer.from(String(req.headers['x-hosted-service-secret'] || '')), expected = Buffer.from(config.secret);
    if (req.method !== 'POST' || !/^\/v1\/(start|status|refresh|reconnect|cancel)$/.test(req.url || '')
        || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        || ['cookie', 'origin', 'sec-fetch-site', 'sec-fetch-dest'].some(header => req.headers[header] !== undefined)
        || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { send(403, { ok: false, code: 'DENIED' }); return; }
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw fail('INVALID'); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID'); }
      send(200, await operation(req.url.split('/').at(-1), input));
    } catch (error) {
      const codes = { INVALID: 400, CONFLICT: 409, CAPACITY: 429, RESOURCE: 503, MISSING: 404, BUSY: 503 };
      send(codes[error.code] || 503, { ok: false, code: Object.hasOwn(codes, error.code) ? error.code : 'BUSY' });
    }
  });
  server.requestTimeout = 65000; server.headersTimeout = 10000;
  let janitorRunning = false;
  async function sweep() {
    if (closing || janitorRunning) return; janitorRunning = true;
    try {
      for (const row of db.prepare('SELECT * FROM runtime_instances WHERE reserved=1').all()) {
        if (locks.has(row.request_id) || row.state === 'mismatch') continue;
        locks.add(row.request_id);
        try {
          if (row.state === 'cleanup_pending') await stop(row);
          else {
            const login = await inspect(row);
            if (['starting', 'waiting_scan', 'expired'].includes(login.state) && now() - row.started_at >= (config.loginIdleMs ?? 600000)) await stop(row);
          }
        } catch {} finally { locks.delete(row.request_id); }
      }
    } finally { janitorRunning = false; }
  }
  const timer = setInterval(sweep, 15000); timer.unref();
  return { server, operation, recover, sweep,
    async close() { closing = true; clearInterval(timer); if (server.listening) await new Promise(resolve => server.close(resolve)); while (locks.size || janitorRunning) await pause(10); await runtime.close?.(); db.close(); }
  };
}

export function createDockerQQAgentRuntime(config, { now = Date.now, fetchImpl = fetch, exec = execFile, spawnImpl = spawn } = {}) {
  const root = path.resolve(config.root), network = path.join(root, 'network');
  fs.mkdirSync(network, { recursive: true, mode: 0o700 });
  const docker = (args, options = {}) => exec(config.dockerBin, ['--host', 'unix://' + config.dockerSocket, ...args], { timeout: 20000, maxBuffer: 12 * 1024 * 1024, ...options });
  const directory = row => path.join(root, row.request_id), name = row => 'qqagent-host-' + row.request_id, agentName = row => name(row) + '-agent';
  const port = (row, offset) => config.basePort + row.slot * 10 + offset;
  const hasMemory = minimum => { try { return Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]) >= minimum; } catch { return false; } };
  const labels = row => ['--label', 'qq-agent.request=' + row.request_id, '--label', 'qq-agent.owner=' + row.owner_user_id];
  function modelTemplate() {
    if (!config.modelTemplateFile) return { settings: {}, speechSource: null };
    if (!path.isAbsolute(config.modelTemplateFile)) throw Error('Hosted model template must be an absolute private file');
    const stat = fs.lstatSync(config.modelTemplateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) throw Error('Hosted model template must be a private regular file');
    const value = JSON.parse(fs.readFileSync(config.modelTemplateFile, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['api', 'providers', 'dshProviderKeys', 'productionBudget', 'speech', 'hostedFundingLimits', 'platform'].includes(key))
        || value.productionBudget?.enabled !== true || !Number.isFinite(value.productionBudget.defaultDailyLimitCny) || value.productionBudget.defaultDailyLimitCny < 0
        || !Number.isFinite(value.productionBudget.totalDailyLimitCny) || value.productionBudget.totalDailyLimitCny <= 0
        || !Number.isFinite(config.maxBotDailyLimitCny) || config.maxBotDailyLimitCny <= 0 || value.productionBudget.totalDailyLimitCny > config.maxBotDailyLimitCny
        || !Number.isFinite(config.maxChatDailyLimitCny) || config.maxChatDailyLimitCny < 0 || value.productionBudget.defaultDailyLimitCny > config.maxChatDailyLimitCny) throw Error('Hosted model template requires explicit bounded funding policy');
    if (value.platform !== undefined && (!exact(value.platform,['resourcesOnly']) || value.platform.resourcesOnly !== true)) throw Error('Hosted platform resource configuration invalid');
    let speechSource = null;
    if (value.speech) {
      if (!exact(value.speech, ['credentialFile', 'timeoutMs']) || !path.isAbsolute(value.speech.credentialFile || '') || !Number.isInteger(value.speech.timeoutMs) || value.speech.timeoutMs < 1000 || value.speech.timeoutMs > 60000) throw Error('Hosted speech configuration invalid');
      const speechStat = fs.lstatSync(value.speech.credentialFile);
      if (!speechStat.isFile() || speechStat.isSymbolicLink() || process.platform !== 'win32' && (speechStat.mode & 0o077) !== 0) throw Error('Hosted speech credential must be a private regular file');
      speechSource = value.speech.credentialFile;
      value.speech = { ...value.speech, credentialFile: '/run/qq-agent/speech.json' };
    }
    if (value.hostedFundingLimits && (typeof value.hostedFundingLimits !== 'object' || Array.isArray(value.hostedFundingLimits)
        || Object.keys(value.hostedFundingLimits).some(key => !['speechDailyLimitCny', 'speechPlatformDailyLimitCny', 'speechCooldownMs'].includes(key))
        || Object.entries(value.hostedFundingLimits).some(([key, amount]) => !Number.isFinite(amount) || amount < 0 || key === 'speechCooldownMs' && (!Number.isInteger(amount) || amount < 1000)))) throw Error('Hosted funding limits invalid');
    // Source accounts, funded chats and old ledger seeds never enter a new bot.
    return { settings: { ...value, productionBudget: { ...value.productionBudget, funding: {}, overrides: {}, initialSpent: {} } }, speechSource };
  }
  const template = modelTemplate();
  function networkRecord(row) {
    try { return JSON.parse(fs.readFileSync(path.join(network, row.request_id + '.json'), 'utf8')); } catch { return null; }
  }
  async function stopNetwork(row) {
    const record = networkRecord(row), socket = path.join(network, row.request_id + '.sock');
    if (record && Number.isSafeInteger(record.helperPid) && record.helperPid > 1) {
      try {
        const args = fs.readFileSync('/proc/' + record.helperPid + '/cmdline').toString('utf8').split('\0');
        // PID reuse must never let cleanup signal an unrelated host process.
        if (args[0] === config.slirpBin && args.includes(socket) && args.includes(String(record.containerPid))) {
          process.kill(record.helperPid, 'SIGTERM');
          for (let retry = 0; retry < 30 && fs.existsSync('/proc/' + record.helperPid); retry++) await pause(50);
          if (fs.existsSync('/proc/' + record.helperPid)) throw fail('BUSY');
        }
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    for (const file of [socket, path.join(network, row.request_id + '.json')]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  function write(file, value, uid, gid) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.new'; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file);
    if (uid !== undefined) fs.chownSync(file, uid, gid);
  }
  async function info(row, agent = false) {
    const expected = agent ? agentName(row) : name(row);
    try {
      const { stdout } = await docker(['inspect', expected]), value = JSON.parse(stdout)[0];
      if (value.Name !== '/' + expected || value.Config?.Labels?.['qq-agent.request'] !== row.request_id || value.Config?.Labels?.['qq-agent.owner'] !== row.owner_user_id
          || !agent && value.HostConfig?.NetworkMode !== 'none') throw fail('CONFLICT');
      return value;
    } catch (error) { if (error.code === 'CONFLICT') throw error; if (/No such (object|container)/i.test(error.stderr || '')) return null; throw error; }
  }
  async function gateway(row, action) {
    try {
      const response = await fetchImpl('http://127.0.0.1:' + port(row, 0) + '/' + action, { method: 'POST', headers: { authorization: 'Bearer ' + row.onebot_token, 'content-type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(2500) });
      if (!response.ok) return null; const body = await response.json(); return body.status === 'ok' ? body.data : null;
    } catch { return null; }
  }
  async function privateNetwork(row, container) {
    const socket = path.join(network, row.request_id + '.sock');
    const command = value => new Promise((resolve, reject) => {
      let body = ''; const client = net.connect(socket);
      client.setTimeout(3000, () => client.destroy(Error('Private network timeout'))); client.on('connect', () => client.end(JSON.stringify(value)));
      client.on('data', data => { body += data; if (body.length > 65536) client.destroy(Error('Private network response too large')); });
      client.on('error', reject); client.on('end', () => { try { const result = JSON.parse(body); if (!Object.hasOwn(result, 'return')) throw Error(); resolve(result.return); } catch { reject(Error('Private network command failed')); } });
    });
    const recorded = networkRecord(row);
    try {
      const result = await command({ execute: 'list_hostfwd' });
      if (recorded?.containerId === container.Id && recorded.containerPid === container.State.Pid
          && [0, 1, 2].every(offset => result.entries?.some(entry => entry.host_port === port(row, offset)))) return;
    } catch {}
    await stopNetwork(row);
    await exec(config.nsenterBin, ['--target', String(container.State.Pid), '--net', config.ipBin, 'link', 'delete', 'tap0'], { timeout: 3000 }).catch(() => {});
    const log = fs.openSync(path.join(directory(row), 'network.log'), 'a', 0o600);
    const child = spawnImpl(config.slirpBin, ['--configure', '--mtu=1500', '--disable-host-loopback', '--enable-seccomp', '--api-socket', socket, String(container.State.Pid), 'tap0'], { env: { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: config.slirpLib }, detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log); child.on('error', () => {}); child.unref();
    write(path.join(network, row.request_id + '.json'), { containerId: container.Id, containerPid: container.State.Pid, helperPid: child.pid });
    for (let retry = 0; retry < 40 && !fs.existsSync(socket); retry++) { if (child.exitCode !== null) throw fail('RESOURCE'); await pause(100); }
    if (!fs.existsSync(socket)) throw fail('RESOURCE');
    for (const [offset, guest] of [[0, 3000], [1, 3001], [2, 3210]]) await command({ execute: 'add_hostfwd', arguments: { proto: 'tcp', host_addr: '127.0.0.1', host_port: port(row, offset), guest_port: guest } });
    await docker(['exec', name(row), 'sh', '-c', 'printf "nameserver 10.0.2.3\\n" > /etc/resolv.conf']);
  }
  function setup(row) {
    const base = directory(row), uid = config.uidBase + row.identity_index, gid = config.gidBase + row.identity_index;
    fs.mkdirSync(base, { recursive: true, mode: 0o711 }); fs.chmodSync(base, 0o711);
    for (const relative of ['qq-config', 'qq-local', 'snowluma/config', 'agent']) fs.mkdirSync(path.join(base, relative), { recursive: true, mode: 0o700 });
    const adapter = (type, endpoint) => ({ name: type + '-default', host: '0.0.0.0', port: endpoint, path: '/', accessToken: row.onebot_token, messageFormat: 'array', reportSelfMessage: false, ...(type === 'ws' ? { role: 'Universal' } : {}) });
    const onebot = path.join(base, 'snowluma/config/onebot.json');
    if (!fs.existsSync(onebot)) write(onebot, { networks: { httpServers: [adapter('http', 3000)], wsServers: [adapter('ws', 3001)], httpClients: [], wsClients: [] } });
    fs.chownSync(path.join(base, 'agent'), uid, gid);
    const file = path.join(base, 'agent/config.json');
    if (!fs.existsSync(file)) write(file, {
      api: { apiKey: '', baseUrl: '', model: '', fallbackModels: [] }, providers: [], dshProviderKeys: {},
      ...template.settings,
      platform: { ...template.settings.platform, enabled: false }, snowluma: { autoLaunch: false, dir: '/var/lib/snowluma', wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: row.onebot_token, httpAccessToken: row.onebot_token },
      server: { port: 3210, token: row.machine_token }, allow: { groups: [], private: [] },
      extensions: { hotReload: false }, ...(!config.modelTemplateFile ? { productionBudget: { enabled: true, funding: {} } } : {}), proactive: { enabled: false },
      tools: { enabled: true, crossChatSend: false, categories: { system: false } }
    }, uid, gid);
    if (template.speechSource) write(path.join(base, 'credentials/speech.json'), JSON.parse(fs.readFileSync(template.speechSource, 'utf8')), uid, gid);
  }
  async function startAgent(row) {
    let container = await info(row, true);
    if (!container?.State.Running && !hasMemory(config.minAgentAvailableMemoryKb || 458752)) throw fail('RESOURCE');
    if (!container) {
      const uid = config.uidBase + row.identity_index, gid = config.gidBase + row.identity_index;
      await docker(['run', '-d', '--name', agentName(row), ...labels(row), '--network', 'container:' + name(row), '--user', uid + ':' + gid,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', config.agentMemory || '192m', '--memory-swap', config.agentMemory || '192m', '--cpus', '0.5', '--pids-limit', '128',
        '--log-opt', 'max-size=8m', '--log-opt', 'max-file=2', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
        '--mount', 'type=bind,src=' + config.codeRoot + ',dst=/opt/qq-agent,readonly', '--mount', 'type=bind,src=' + path.join(directory(row), 'agent') + ',dst=/var/lib/qq-agent',
        ...(template.speechSource ? ['--mount', 'type=bind,src=' + path.join(directory(row), 'credentials/speech.json') + ',dst=/run/qq-agent/speech.json,readonly'] : []),
        '-e', 'HOME=/var/lib/qq-agent', '-e', 'TZ=Asia/Shanghai', '-e', 'QQ_AGENT_DATA_DIR=/var/lib/qq-agent', '-e', 'QQ_AGENT_PORT=3210',
        '-e', 'QQ_AGENT_HOSTED_BIND_HOST=0.0.0.0',
        '-e', 'QQ_AGENT_HOSTED_BOT_ID=hosted-' + row.request_id, '-e', 'QQ_AGENT_HOSTED_EXPECTED_QQ=' + row.expected_qq, '-e', 'NODE_OPTIONS=--max-old-space-size=128',
        '--workdir', '/var/lib/qq-agent', config.agentImage, 'node', '/opt/qq-agent/src/server.js'], { timeout: 45000 });
      container = await info(row, true);
    } else if (!container.State.Running) await docker(['start', agentName(row)]);
  }
  async function inspect(row) {
    const login = await gateway(row, 'get_login_info');
    if (Number(login?.user_id) > 0) {
      const actualQQ = String(login.user_id);
      if (actualQQ !== row.expected_qq) return { actualQQ, online: false, agentReady: false };
      const online = (await gateway(row, 'get_status'))?.online === true;
      if (!online) return { actualQQ, online: false, agentReady: false };
      await startAgent(row);
      let agentReady = false;
      try {
        const response = await fetchImpl('http://127.0.0.1:' + port(row, 2) + '/api/hosted/identity', { headers: { 'x-console-token': row.machine_token }, redirect: 'error', signal: AbortSignal.timeout(2500) });
        const value = await response.json();
        agentReady = response.ok && value.ok === true && value.botId === 'hosted-' + row.request_id && value.expectedQQ === row.expected_qq && String(value.actualQQ) === row.expected_qq && value.qqOnline === true && value.agentReady === true;
      } catch {}
      return { actualQQ, online, agentReady };
    }
    if (now() - row.qr_at >= 120000) return {};
    try {
      const { stdout: tree } = await docker(['exec', '-e', 'DISPLAY=:1', name(row), 'xwininfo', '-root', '-tree']);
      const window = findHostedQQLoginWindow(tree); if (!window) return {};
      const { stdout: visibility } = await docker(['exec', '-e', 'DISPLAY=:1', name(row), 'xwininfo', '-id', window.id]);
      if (!/^\s*Map State:\s+IsViewable\s*$/m.test(visibility)) return {};
      const { stdout: frame } = await docker(['exec', '-e', 'DISPLAY=:1', name(row), 'xwd', '-id', window.id, '-silent'], { encoding: 'buffer' });
      const after = await gateway(row, 'get_login_info');
      if (Number(after?.user_id) > 0) return { actualQQ: String(after.user_id), online: false, agentReady: false };
      const { stdout: afterVisibility } = await docker(['exec', '-e', 'DISPLAY=:1', name(row), 'xwininfo', '-id', window.id]);
      if (!/^\s*Map State:\s+IsViewable\s*$/m.test(afterVisibility)) return {};
      return { qrImage: 'data:image/png;base64,' + hostedLoginWindowPng(frame, { ...window, x: 0, y: 0 }).toString('base64') };
    } catch { return {}; }
  }
  return {
    async capacity() { return hasMemory(config.minAvailableMemoryKb || 1120000); },
    async start(row) {
      let container = await info(row);
      if (!container?.State.Running && !hasMemory(config.minAvailableMemoryKb || 1120000)) throw fail('RESOURCE');
      setup(row);
      if (!container) {
        const base = directory(row);
        await docker(['run', '-d', '--name', name(row), ...labels(row), '--network', 'none', '--cap-add', 'SYS_PTRACE', '--security-opt', 'seccomp=unconfined',
          '--memory', config.qqMemory || '640m', '--memory-swap', config.qqMemory || '640m', '--shm-size', '256m', '--cpus', '0.8', '--pids-limit', '256', '--ulimit', 'nofile=65536:65536',
          '--log-opt', 'max-size=8m', '--log-opt', 'max-file=2', '-e', 'SNOWLUMA_ONEBOT_HOST=0.0.0.0', '-e', 'SNOWLUMA_WEBUI_HOST=0.0.0.0', '-e', 'SNOWLUMA_SCREEN=1024x768x24',
          '--mount', 'type=bind,src=' + path.join(base, 'qq-config') + ',dst=/app/.config', '--mount', 'type=bind,src=' + path.join(base, 'qq-local') + ',dst=/app/.local/share',
          '--mount', 'type=bind,src=' + path.join(base, 'snowluma') + ',dst=/app/data', '--mount', 'type=bind,src=' + config.startScript + ',dst=/root/start.sh,readonly', config.image], { timeout: 45000 });
        container = await info(row);
      } else if (!container.State.Running) { await docker(['start', name(row)]); container = await info(row); }
      if (!container?.State.Running) throw fail('RESOURCE');
      await privateNetwork(row, container);
    },
    inspect,
    async stop(row) {
      // Remove the Agent first: no stale sender survives a namespace restart.
      for (const agent of [true, false]) {
        const container = await info(row, agent); if (!container) continue;
        await docker(['rm', '-f', agent ? agentName(row) : name(row)], { timeout: 20000 });
      }
      await stopNetwork(row);
    },
    async refresh(row) {
      const login = await gateway(row, 'get_login_info'); if (Number(login?.user_id) > 0) return;
      const { stdout: tree } = await docker(['exec', '-e', 'DISPLAY=:1', name(row), 'xwininfo', '-root', '-tree']);
      const window = findHostedQQLoginWindow(tree); if (!window) throw fail('BUSY');
      const program = "import ctypes,time; x=ctypes.CDLL('libX11.so.6'); t=ctypes.CDLL('libXtst.so.6'); x.XOpenDisplay.restype=ctypes.c_void_p; d=x.XOpenDisplay(None); assert d; x.XDefaultRootWindow.argtypes=[ctypes.c_void_p]; x.XDefaultRootWindow.restype=ctypes.c_ulong; r=x.XDefaultRootWindow(d); x.XWarpPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_int,ctypes.c_int]; t.XTestFakeButtonEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]; x.XFlush.argtypes=[ctypes.c_void_p]; "
        + [[0.75, 0.60], [0.5, 0.61]].map(([x, y]) => 'x.XWarpPointer(d,0,r,0,0,0,0,' + Math.round(window.x + window.width * x) + ',' + Math.round(window.y + window.height * y) + '); t.XTestFakeButtonEvent(d,1,1,0); t.XTestFakeButtonEvent(d,1,0,0); x.XFlush(d); time.sleep(.3)').join('; ');
      await docker(['exec', '-e', 'DISPLAY=:1', name(row), 'python3', '-c', program]); await pause(500);
    }
  };
}

// Adapted from the owner's earlier qq-bot login-frame parser. The only accepted
// frame is the pinned QQ login window, never a main chat window or full desktop.
export function findHostedQQLoginWindow(tree) {
  for (const line of String(tree).split('\n')) {
    const match = /^\s*(0x[0-9a-f]+) "(?:QQ|QQ登录|QQ Login)":.*?\s(\d+)x(\d+)[+-]\d+[+-]\d+\s+([+-]\d+)([+-]\d+)\s*$/i.exec(line);
    if (!match) continue;
    const [width, height, x, y] = match.slice(2).map(Number);
    if (width === 320 && height === 460 && x >= 0 && y >= 0) return { id: match[1], x, y, width, height };
  }
  return null;
}
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function pngChunk(type, data) {
  const tag = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); tag.copy(result, 4); data.copy(result, 8);
  let crc = 0xffffffff; for (const byte of Buffer.concat([tag, data])) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
export function hostedLoginWindowPng(image, crop) {
  if (!Buffer.isBuffer(image) || image.length < 104 || image.length > 12 * 1024 * 1024) throw Error('Invalid X11 frame');
  const field = index => image.readUInt32BE(index * 4), header = field(0), width = field(4), height = field(5), order = field(7), bits = field(11), stride = field(12), start = header + field(19) * 12;
  if (field(1) !== 7 || field(2) !== 2 || ![0, 1].includes(order) || ![24, 32].includes(bits) || header < 100 || width > 4096 || height > 4096 || stride < width * bits / 8 || stride > 32768
      || start + stride * height > image.length || field(14) !== 0xff0000 || field(15) !== 0xff00 || field(16) !== 0xff) throw Error('Unsupported X11 frame');
  if (!crop || !['x', 'y', 'width', 'height'].every(key => Number.isInteger(crop[key])) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > width || crop.y + crop.height > height) throw Error('Invalid QQ window bounds');
  const raw = Buffer.alloc((crop.width * 3 + 1) * crop.height), bytes = bits / 8;
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
    const source = start + (crop.y + y) * stride + (crop.x + x) * bytes, target = y * (crop.width * 3 + 1) + 1 + x * 3;
    if (order === 0) { raw[target] = image[source + 2]; raw[target + 1] = image[source + 1]; raw[target + 2] = image[source]; }
    else { const offset = bytes === 4 ? 1 : 0; raw[target] = image[source + offset]; raw[target + 1] = image[source + offset + 1]; raw[target + 2] = image[source + offset + 2]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(crop.width); ihdr.writeUInt32BE(crop.height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (config.secretFile) config.secret = fs.readFileSync(config.secretFile, 'utf8').trim();
  const service = createHostedQQAgentService(config);
  await service.recover();
  service.server.listen(config.port, '127.0.0.1', () => console.log('Private hosted QQ Agent service ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}
