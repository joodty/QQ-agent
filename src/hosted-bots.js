import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { publicHostedLoginState } from './hosted-login-client.js';

const APP_ID = 0x51504842;
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const qq = value => typeof value === 'string' && /^[1-9]\d{4,14}$/.test(value) && Number.isSafeInteger(Number(value));
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

/** SQL is authoritative for owner/QQ/slot/version; browser input supplies only
 * requestId (and optional compare-and-swap version) after creation. */
export function createHostedBots({ file, platformStore, loginClient = null, now = Date.now, maxBots = 1, cooldownMs = 30000, leaseMs = 120000, pendingTtlMs = 600000, onReady = async () => {} } = {}) {
  if (!path.isAbsolute(file || '') || !platformStore?.verifiedSession || !Number.isInteger(maxBots) || maxBots < 1 || maxBots > 16) throw new Error('Hosted bot store configuration invalid');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000;');
  const appId = db.prepare('PRAGMA application_id').get().application_id, schema = db.prepare('PRAGMA user_version').get().user_version;
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (!(appId === 0 && schema === 0 && tables.length === 0) && (appId !== APP_ID || schema !== 1 || !tables.some(row => row.name === 'hosted_requests'))) { db.close(); throw fail(503, '私人QQ接入数据库格式不受支持，禁止覆盖'); }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS hosted_requests (
    id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, expected_qq TEXT NOT NULL, name TEXT NOT NULL,
    slot INTEGER, status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_start_at INTEGER NOT NULL DEFAULT 0, reason TEXT, operation_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS hosted_live_slot ON hosted_requests(slot) WHERE slot IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS hosted_live_qq ON hosted_requests(expected_qq) WHERE slot IS NOT NULL;
  PRAGMA application_id=${APP_ID}; PRAGMA user_version=1; PRAGMA journal_mode=WAL;`);
  const sql = (query, ...params) => db.prepare(query).run(...params);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function expirePending() {
    // Only requests whose start intent was never issued can be reclaimed here.
    // Every uncertain runtime operation retains its slot until broker cleanup.
    sql("UPDATE hosted_requests SET status='stopped',slot=NULL,version=version+1,updated_at=?,reason=? WHERE status='pending' AND operation_token IS NULL AND created_at<=?", now(), '申请超时，名额已释放；可重新启动接入', now() - pendingTtlMs);
  }
  function actor(value) {
    if (value?.kind !== 'session' || !value.sessionHash) throw fail(401, '请先登录');
    const fresh = platformStore.verifiedSession(value.sessionHash);
    if (!fresh || fresh.id !== value.id || fresh.passwordVersion !== value.passwordVersion) throw fail(401, '登录已失效，请重新登录');
    return fresh;
  }
  const publicRow = row => ({ id: row.id, requestId: row.id, ownerUserId: row.owner_user_id, expectedQQ: row.expected_qq, botId: 'hosted-' + row.id, name: row.name,
    slot: row.slot, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, reason: row.reason });
  function owned(principal, input) {
    const fresh = actor(principal);
    if (!fields(input, ['requestId', 'version']) || !id(input.requestId) || input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1)) throw fail(400, '申请标识或版本无效');
    const row = db.prepare('SELECT * FROM hosted_requests WHERE id=? AND owner_user_id=?').get(input.requestId, fresh.id);
    if (!row) throw fail(404, '接入申请不存在');
    if (input.version !== undefined && input.version !== row.version) throw fail(409, '接入申请已变化，请刷新');
    return row;
  }
  function available(rowId = '') {
    const used = new Set(db.prepare('SELECT slot FROM hosted_requests WHERE slot IS NOT NULL AND id<>?').all(rowId).map(row => row.slot));
    for (let slot = 0; slot < maxBots; slot++) if (!used.has(slot)) return slot;
    throw fail(429, '私人QQ托管名额已满');
  }
  const brokerInput = row => ({ requestId: row.id, ownerUserId: row.owner_user_id, expectedQQ: row.expected_qq, slot: row.slot, version: row.version });
  async function operation(action, principal, input) {
    if (!loginClient?.[action]) throw fail(503, '平台尚未启用私人QQ扫码接入');
    const token = crypto.randomBytes(16).toString('hex');
    let before;
    transaction(() => {
      expirePending();
      const row = owned(principal, input);
      if (row.lease_until > now()) throw fail(409, '接入正在处理中，请稍后刷新');
      if (action !== 'cancel' && row.status === 'cleanup_pending') throw fail(409, '实例正在停止，请先重试停止接入');
      if (['start', 'reconnect'].includes(action)) {
        if(db.prepare('SELECT 1 FROM hosted_requests WHERE owner_user_id=? AND id<>? AND slot IS NOT NULL').get(row.owner_user_id,row.id))throw fail(409,'本人已有正在使用的接入申请');
        if(db.prepare('SELECT 1 FROM hosted_requests WHERE expected_qq=? AND id<>? AND slot IS NOT NULL').get(row.expected_qq,row.id))throw fail(409,'该QQ已有正在使用的接入申请');
        if (row.status === 'mismatch') throw fail(409, '扫码QQ与申请不符，请停止后重新申请');
        if (row.last_start_at && now() - row.last_start_at < cooldownMs) throw fail(429, '接入操作过于频繁，请稍后重试');
        if (row.slot === null) row.slot = available(row.id);
      }
      if (action !== 'cancel' && row.slot === null) throw fail(409, '请先启动接入');
      const status = ['start', 'reconnect'].includes(action) ? 'starting' : action === 'cancel' ? 'cleanup_pending' : row.status;
      sql('UPDATE hosted_requests SET slot=?,status=?,version=version+1,operation_token=?,lease_until=?,updated_at=?,last_start_at=? WHERE id=?', row.slot, status, token, now() + leaseMs, now(), ['start', 'reconnect'].includes(action) ? now() : row.last_start_at, row.id);
      before = db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(row.id);
    });
    let result;
    try {
      result = before.slot === null && action === 'cancel' ? { login: { state: 'stopped' } } : await loginClient[action](brokerInput(before));
      actor(principal);
      const login = publicHostedLoginState(result.login);
      if (login.state === 'ready') {
        if (!result.connection || result.connection.botId !== 'hosted-' + before.id || result.connection.expectedQQ !== before.expected_qq) throw fail(502, '私人QQ实例身份未完成核验');
        await onReady({ request: publicRow(before), connection: result.connection });
        actor(principal);
      }
      const request = transaction(() => {
        owned(principal, { requestId: before.id });
        const current = db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(before.id);
        if (current.operation_token !== token) throw fail(409, '申请处理版本已变化，请刷新');
        const terminal = login.state === 'stopped';
        sql('UPDATE hosted_requests SET status=?,slot=?,reason=?,operation_token=NULL,lease_until=0,updated_at=? WHERE id=?', login.state, terminal ? null : current.slot,
          login.state === 'mismatch' ? '扫码QQ与申请号码不符，实例已暂停' : null, now(), current.id);
        return publicRow(db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(current.id));
      });
      return { request, login };
    } catch (error) {
      // Starting can succeed despite an HTTP timeout. Release capacity only when
      // the broker positively confirms stop; otherwise retain a repairable slot.
      let clean = false;
      if (['start', 'reconnect', 'cancel'].includes(action) || result?.login?.state === 'ready') {
        try { clean = (await loginClient.cancel(brokerInput(before))).login?.state === 'stopped'; } catch {}
      }
      transaction(() => {
        const current = db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(before.id);
        if (current?.operation_token !== token) return;
        const state = clean ? 'stopped' : ['start', 'reconnect', 'cancel'].includes(action) || result?.login?.state === 'ready' ? 'cleanup_pending' : current.status;
        sql('UPDATE hosted_requests SET status=?,slot=?,reason=?,operation_token=NULL,lease_until=0,updated_at=? WHERE id=?', state, clean ? null : current.slot,
          clean ? '本次接入未完成，实例已停止' : '接入未完成，请稍后刷新或停止接入', now(), current.id);
      });
      throw error;
    }
  }
  return {
    overview(principal) {
      return transaction(() => {
        const fresh = actor(principal); expirePending();
        const requests = db.prepare('SELECT * FROM hosted_requests WHERE owner_user_id=? ORDER BY created_at DESC,id').all(fresh.id).map(publicRow);
        const used = db.prepare('SELECT COUNT(*) AS n FROM hosted_requests WHERE slot IS NOT NULL').get().n;
        return { enabled: Boolean(loginClient), requests, capacity: { max: maxBots, used, available: Math.max(0, maxBots - used) } };
      });
    },
    create(principal, input) {
      return transaction(() => {
        const fresh = actor(principal);
        expirePending();
        if (!fields(input, ['expectedQQ', 'name']) || !qq(input.expectedQQ) || input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name))) throw fail(400, 'QQ号码或接入名称无效');
        if (!loginClient) throw fail(503, '平台尚未启用私人QQ扫码接入');
        if (db.prepare('SELECT 1 FROM hosted_requests WHERE owner_user_id=? AND slot IS NOT NULL').get(fresh.id)) throw fail(409, '本人已有正在使用的接入申请');
        if (db.prepare('SELECT 1 FROM hosted_requests WHERE expected_qq=? AND slot IS NOT NULL').get(input.expectedQQ)) throw fail(409, '该QQ已有接入申请');
        const recent = db.prepare('SELECT MAX(created_at) AS at FROM hosted_requests WHERE owner_user_id=?').get(fresh.id)?.at;
        if (recent && now() - recent < cooldownMs) throw fail(429, '申请过于频繁，请稍后重试');
        const requestId = crypto.randomBytes(16).toString('hex'), slot = available();
        sql('INSERT INTO hosted_requests (id,owner_user_id,expected_qq,name,slot,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', requestId, fresh.id, input.expectedQQ, (input.name || '我的QQ').trim(), slot, 'pending', 1, now(), now());
        return publicRow(db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(requestId));
      });
    },
    ...Object.fromEntries(['start', 'status', 'refresh', 'reconnect', 'cancel'].map(action => [action, (principal, input) => operation(action, principal, input)])),
    /** Server-only catalogue. It intentionally contains no credential. Resolve
     * live credentials via the authenticated broker immediately before use. */
    listRuntime() { return db.prepare("SELECT * FROM hosted_requests WHERE status='ready'").all().map(publicRow); },
    // Server-only confirmation after the private broker positively stopped an
    // account-disabled worker. Never overwrite an overlapping browser action.
    confirmStopped({requestId,version}) {
      return transaction(()=>{
        const row=db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(requestId);
        if(!row||row.version!==version||row.operation_token)return false;
        sql("UPDATE hosted_requests SET status='stopped',slot=NULL,version=version+1,updated_at=?,reason=? WHERE id=?",now(),'所属账号已停用，实例已停止',row.id);
        return true;
      });
    },
    async connection(requestId) {
      if (!id(requestId)) throw fail(400, '接入申请标识无效');
      const row = db.prepare("SELECT * FROM hosted_requests WHERE id=? AND status='ready'").get(requestId);
      if (!row || row.slot === null || !loginClient) throw fail(409, '私人QQ实例尚未就绪');
      const result = await loginClient.status(brokerInput(row));
      const current = db.prepare('SELECT * FROM hosted_requests WHERE id=?').get(requestId);
      if (!current || current.version !== row.version || current.status !== 'ready' || result.login?.state !== 'ready'
          || !result.connection || result.connection.botId !== 'hosted-' + row.id || result.connection.expectedQQ !== row.expected_qq) throw fail(409, '私人QQ实例状态已变化，请刷新');
      return { ...result.connection, origin: 'http://127.0.0.1:' + result.connection.port };
    },
    close() { db.close(); }
  };
}
