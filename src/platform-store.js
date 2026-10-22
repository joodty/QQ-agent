// Standalone account/RBAC state. No legacy service, runtime paths or API keys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validatePlatformAuthText, platformBotScopes, normalizePlatformScopeKey } from './platform-auth-core.js';

const APP_ID = 0x51504155;
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const botOf = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw fail(400, '无效机器人标识'); return value; };
const qqOf = value => { if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw fail(400, 'QQ号码格式无效'); return value; };
const safeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const safeTime = value => Number.isSafeInteger(value) && value > 0;
const HASH = /^[a-f0-9]{64}$/;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));

export function validatePlatformAccountBundle(bundle) {
  if (!fields(bundle, ['format', 'version', 'sourceId', 'auth', 'bindings', 'challenges', 'delegations', 'conversations']) || bundle.format !== 'qq-agent-platform-accounts' || bundle.version !== 1
    || typeof bundle.sourceId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(bundle.sourceId)) throw fail(400, '账号迁移资料格式无效');
  const auth = validatePlatformAuthText(JSON.stringify(bundle.auth));
  const users = new Set(auth.users.map(user => user.id));
  const bindings = bundle.bindings || [], challenges = bundle.challenges || [], delegations = bundle.delegations || [], conversations = bundle.conversations || [];
  for (const list of [bindings, challenges, delegations, conversations]) if (!Array.isArray(list) || list.length > 10000) throw fail(400, '账号迁移列表无效');
  const boundUsers = new Set(), boundQqs = new Set(), challengeIds = new Set(), challengeHashes = new Set();
  for (const binding of bindings) {
    if (!fields(binding, ['userId', 'qq', 'verifiedAt']) || !users.has(binding.userId) || !safeTime(binding.verifiedAt) || boundUsers.has(binding.userId) || boundQqs.has(binding.qq)) throw fail(400, 'QQ绑定引用或唯一性无效');
    qqOf(binding.qq); boundUsers.add(binding.userId); boundQqs.add(binding.qq);
  }
  for (const row of challenges) {
    if (!fields(row, ['id', 'userId', 'qq', 'codeHash', 'createdAt', 'expiresAt', 'attempts', 'consumedAt']) || !safeId(row.id) || !users.has(row.userId) || !HASH.test(row.codeHash || '') || !safeTime(row.createdAt) || !safeTime(row.expiresAt)
      || row.expiresAt <= row.createdAt || !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > 5
      || !(row.consumedAt === null || safeTime(row.consumedAt)) || challengeIds.has(row.id) || challengeHashes.has(row.codeHash)) throw fail(400, 'QQ验证挑战无效');
    qqOf(row.qq); challengeIds.add(row.id); challengeHashes.add(row.codeHash);
  }
  for (const row of delegations) {
    if (!fields(row, ['userId', 'botId', 'key']) || !users.has(row.userId)) throw fail(400, '委托账号不存在');
    botOf(row.botId); if (normalizePlatformScopeKey(row.key) !== row.key) throw fail(400, '委托聊天标识未规范化');
  }
  for (const row of conversations) { if (!fields(row, ['botId', 'key'])) throw fail(400, '聊天字段无效'); botOf(row.botId); if (normalizePlatformScopeKey(row.key) !== row.key) throw fail(400, '聊天标识未规范化'); }
  return { format: bundle.format, version: 1, sourceId: bundle.sourceId, auth, bindings, challenges, delegations, conversations };
}

export function createPlatformStore({ file, now = Date.now } = {}) {
  if (!file || !path.isAbsolute(file)) throw new Error('An absolute standalone platform SQLite path is required');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const application = db.prepare('PRAGMA application_id').get().application_id;
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  const existingTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const requiredTables = ['platform_meta', 'accounts', 'auth_sessions', 'account_scopes', 'account_epochs', 'scope_proofs', 'qq_bindings', 'binding_challenges', 'managed_conversations', 'account_imports'];
  const fresh = application === 0 && schema === 0 && existingTables.length === 0;
  if (!fresh && (application !== APP_ID || schema !== 1 || requiredTables.some(name => !existingTables.some(row => row.name === name)))) { db.close(); throw fail(503, '平台数据库格式不受支持，禁止覆盖'); }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,role TEXT NOT NULL CHECK(role IN ('admin','user')),disabled INTEGER NOT NULL CHECK(disabled IN (0,1)),password_algorithm TEXT NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,password_version INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_admin ON accounts(role) WHERE role='admin';
    CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,password_version INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>created_at)) STRICT;
    CREATE TABLE IF NOT EXISTS account_scopes (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,conversation_key TEXT NOT NULL,PRIMARY KEY(account_id,bot_id,conversation_key)) STRICT;
    CREATE TABLE IF NOT EXISTS account_epochs (account_id TEXT PRIMARY KEY REFERENCES accounts(id),epoch INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS scope_proofs (account_id TEXT NOT NULL REFERENCES accounts(id),bot_id TEXT NOT NULL,conversation_key TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('explicit','qq-group')),epoch INTEGER NOT NULL,verified_at INTEGER NOT NULL,expires_at INTEGER,revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),PRIMARY KEY(account_id,bot_id,conversation_key)) STRICT;
    CREATE TABLE IF NOT EXISTS qq_bindings (qq TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),verified_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS binding_challenges (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id),qq TEXT NOT NULL,code_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 5),consumed_at INTEGER) STRICT;
    CREATE TABLE IF NOT EXISTS managed_conversations (bot_id TEXT NOT NULL,conversation_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,conversation_key)) STRICT;
    CREATE TABLE IF NOT EXISTS account_imports (source_id TEXT PRIMARY KEY,digest TEXT NOT NULL,counts_json TEXT NOT NULL,imported_at INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO platform_meta VALUES ('revision','0');
    PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
  `);
  db.exec('PRAGMA journal_mode=WAL;');
  let depth = 0;
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const version = () => Number(db.prepare("SELECT value FROM platform_meta WHERE key='revision'").get().value);
  const bump = () => run("UPDATE platform_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
  function transaction(fn) {
    const nested = depth > 0, savepoint = 'platform_' + depth;
    db.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE'); depth++;
    try { const result = fn(); if (result?.then) throw new Error('SQLite transaction callback must be synchronous'); db.exec(nested ? 'RELEASE ' + savepoint : 'COMMIT'); return result; }
    catch (error) { db.exec(nested ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK'); if (nested) db.exec('RELEASE ' + savepoint); throw error; }
    finally { depth--; }
  }
  function readSnapshot(fn) {
    if (depth) return fn();
    db.exec('BEGIN'); depth++;
    try { const result = fn(); if (result?.then) throw new Error('SQLite read snapshot must be synchronous'); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { depth--; }
  }
  const expect = expected => { if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== version())) throw fail(409, '账号或权限已变化，请刷新后重试'); };
  function userFromRow(row) {
    if (!row) return null;
      const botScopes = platformBotScopes({ botScopes: db.prepare('SELECT bot_id AS botId,conversation_key AS key FROM account_scopes WHERE account_id=?').all(row.id) });
      return { id: row.id, username: row.username, role: row.role, disabled: Boolean(row.disabled),
        conversationKeys: botScopes.filter(scope => scope.botId === 'primary').map(scope => scope.key), botScopes,
        password: { algorithm: row.password_algorithm, salt: row.password_salt, key: row.password_hash }, passwordVersion: row.password_version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function readAuth() {
    return readSnapshot(() => {
    const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at,id').all();
    if (!rows.length) return null;
    const users = rows.map(userFromRow);
    const sessions = db.prepare('SELECT hash,account_id AS userId,password_version AS passwordVersion,created_at AS createdAt,expires_at AS expiresAt FROM auth_sessions ORDER BY created_at,hash').all();
    return { version: 1, users, sessions };
    });
  }
  const authText = () => { const data = readAuth(); return data ? JSON.stringify(data, null, 2) + '\n' : null; };
  function writeAuth(text, expected, expectedVersion, { explicitScopeUsers = [] } = {}) {
    const state = validatePlatformAuthText(text);
    return transaction(() => {
      expect(expectedVersion);
      if (authText() !== expected) throw fail(409, '账号存储已变化，请重新操作');
      const before = readAuth();
      const priorUsers = new Map((before?.users || []).map(user => [user.id, user]));
      const nextScopeIds = new Set(state.users.flatMap(user => platformBotScopes(user).map(scope => JSON.stringify([user.id, scope.botId, scope.key]))));
      for (const row of db.prepare('SELECT account_id,bot_id,conversation_key FROM account_scopes').all()) {
        if (!nextScopeIds.has(JSON.stringify([row.account_id, row.bot_id, row.conversation_key]))) run('UPDATE scope_proofs SET revoked=1,epoch=epoch+1 WHERE account_id=? AND bot_id=? AND conversation_key=?', row.account_id, row.bot_id, row.conversation_key);
      }
      // All account/session changes are adopted atomically; unrelated bindings
      // remain authoritative in their own tables and are never regenerated.
      run('DELETE FROM auth_sessions'); run('DELETE FROM account_scopes');
      const ids = new Set(state.users.map(user => user.id));
      for (const row of db.prepare('SELECT id FROM accounts').all()) if (!ids.has(row.id)) run('DELETE FROM accounts WHERE id=?', row.id);
      for (const user of state.users) {
        run('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,role=excluded.role,disabled=excluded.disabled,password_algorithm=excluded.password_algorithm,password_salt=excluded.password_salt,password_hash=excluded.password_hash,password_version=excluded.password_version,created_at=excluded.created_at,updated_at=excluded.updated_at',
          user.id, user.username, user.role, Number(user.disabled), user.password.algorithm, user.password.salt, user.password.key, user.passwordVersion, user.createdAt, user.updatedAt);
        run('INSERT OR IGNORE INTO account_epochs VALUES (?,1)', user.id);
        const prior = priorUsers.get(user.id);
        if (prior && (prior.disabled !== user.disabled || prior.role !== user.role || prior.passwordVersion !== user.passwordVersion)) run('UPDATE account_epochs SET epoch=epoch+1 WHERE account_id=?', user.id);
        for (const scope of platformBotScopes(user)) {
          run('INSERT INTO account_scopes VALUES (?,?,?)', user.id, scope.botId, scope.key);
          run('INSERT OR IGNORE INTO managed_conversations VALUES (?,?,?)', scope.botId, scope.key, now());
          const proof = db.prepare('SELECT * FROM scope_proofs WHERE account_id=? AND bot_id=? AND conversation_key=?').get(user.id, scope.botId, scope.key);
          if (!proof) run('INSERT INTO scope_proofs VALUES (?,?,?,?,?,?,?,?)', user.id, scope.botId, scope.key, 'explicit', 1, now(), null, 0);
          else if ((proof.revoked && !platformBotScopes(prior || {}).some(old => old.botId === scope.botId && old.key === scope.key))
            || explicitScopeUsers.includes(user.id) && (proof.source !== 'explicit' || proof.revoked)) run("UPDATE scope_proofs SET source='explicit',epoch=epoch+1,verified_at=?,expires_at=NULL,revoked=0 WHERE account_id=? AND bot_id=? AND conversation_key=?", now(), user.id, scope.botId, scope.key);
        }
      }
      for (const session of state.sessions) run('INSERT INTO auth_sessions VALUES (?,?,?,?,?)', session.hash, session.userId, session.passwordVersion, session.createdAt, session.expiresAt);
      bump(); return version();
    });
  }
  const getBinding = userId => db.prepare('SELECT qq,user_id AS userId,verified_at AS verifiedAt FROM qq_bindings WHERE user_id=?').get(userId) || null;
  const permissionVersion = (userId, key, botId = 'primary') => readSnapshot(() => {
    const account = db.prepare('SELECT epoch FROM account_epochs WHERE account_id=?').get(userId)?.epoch || 0;
    const scope = db.prepare('SELECT epoch FROM scope_proofs WHERE account_id=? AND bot_id=? AND conversation_key=?').get(userId, botId, key)?.epoch || 0;
    return account + ':' + scope;
  });
  return {
    db, version, transaction, readSnapshot, readAuth, authText, writeAuth,
    account(userId) { return readSnapshot(() => userFromRow(db.prepare('SELECT * FROM accounts WHERE id=?').get(userId))); },
    verifiedSession(hash) {
      if (!HASH.test(hash || '')) return null;
      return readSnapshot(() => {
      const row = db.prepare('SELECT a.* FROM auth_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.expires_at>? AND s.password_version=a.password_version AND a.disabled=0').get(hash, now());
      return row ? { ...userFromRow(row), kind: 'session', sessionHash: hash } : null;
      });
    },
    binding: getBinding,
    permissionVersion,
    scopeAllowed(userId, key, botId = 'primary') {
      const scope = db.prepare('SELECT p.* FROM account_scopes s LEFT JOIN scope_proofs p ON p.account_id=s.account_id AND p.bot_id=s.bot_id AND p.conversation_key=s.conversation_key WHERE s.account_id=? AND s.bot_id=? AND s.conversation_key=?').get(userId, botId, key);
      return !!scope && !scope.revoked && (scope.source !== 'qq-group' || scope.expires_at > now());
    },
    automaticGrants() { return readSnapshot(() => db.prepare("SELECT p.account_id AS userId,p.bot_id AS botId,p.conversation_key AS key,p.expires_at AS expiresAt,p.revoked FROM scope_proofs p JOIN account_scopes s ON s.account_id=p.account_id AND s.bot_id=p.bot_id AND s.conversation_key=p.conversation_key WHERE p.source='qq-group'").all().map(row => ({ ...row, permissionVersion: permissionVersion(row.userId, row.key, row.botId) }))); },
    invalidateGroup(botId, groupId, userId, { expectedPermissionVersion } = {}) {
      const key = normalizePlatformScopeKey('group:' + groupId);
      return transaction(() => {
        if (expectedPermissionVersion !== undefined && permissionVersion(userId, key, botId) !== expectedPermissionVersion) throw fail(409, '群权限在核验期间变化，请重试');
        const rows = db.prepare("SELECT account_id FROM scope_proofs WHERE bot_id=? AND conversation_key=? AND source='qq-group' AND revoked=0").all(botId, key);
        let changed = 0;
        for (const row of rows) if (!userId || row.account_id === userId) { run('UPDATE scope_proofs SET revoked=1,epoch=epoch+1 WHERE account_id=? AND bot_id=? AND conversation_key=?', row.account_id, botId, key); changed++; }
        if (changed) bump(); return changed;
      });
    },
    registerConversations(keys, botId = 'primary') { botOf(botId); return transaction(() => { for (const key of keys) run('INSERT OR IGNORE INTO managed_conversations VALUES (?,?,?)', botId, normalizePlatformScopeKey(key), now()); }); },
    conversations(botId = 'primary') { return db.prepare('SELECT conversation_key FROM managed_conversations WHERE bot_id=? ORDER BY conversation_key').all(botOf(botId)).map(row => row.conversation_key); },
    grant(userId, key, botId = 'primary', { automatic = false, ttlMs = 120000, expectedPermissionVersion } = {}) {
      botOf(botId); key = normalizePlatformScopeKey(key);
      return transaction(() => {
        if (expectedPermissionVersion !== undefined && permissionVersion(userId, key, botId) !== expectedPermissionVersion) throw fail(409, '群权限在核验期间变化，请重试');
        const user = db.prepare('SELECT disabled FROM accounts WHERE id=?').get(userId);
        if (!user || user.disabled) throw fail(403, '账号不存在或已停用');
        run('INSERT OR IGNORE INTO account_scopes VALUES (?,?,?)', userId, botId, key);
        run('INSERT OR IGNORE INTO managed_conversations VALUES (?,?,?)', botId, key, now());
        const prior = db.prepare('SELECT * FROM scope_proofs WHERE account_id=? AND bot_id=? AND conversation_key=?').get(userId, botId, key);
        if (automatic && prior?.source === 'explicit' && !prior.revoked) return;
        const source = automatic ? 'qq-group' : 'explicit', expires = automatic ? now() + ttlMs : null;
        const changed = !prior || prior.revoked || prior.source !== source;
        if (!prior) run('INSERT INTO scope_proofs VALUES (?,?,?,?,?,?,?,?)', userId, botId, key, source, 1, now(), expires, 0);
        else run('UPDATE scope_proofs SET source=?,epoch=epoch+?,verified_at=?,expires_at=?,revoked=0 WHERE account_id=? AND bot_id=? AND conversation_key=?', source,
          Number(Boolean(prior.revoked || prior.source !== source)), now(), expires, userId, botId, key);
        if (changed) bump();
      });
    },
    issueBinding(userId, qq) {
      qq = qqOf(qq);
      return transaction(() => {
        const at = now(), user = db.prepare('SELECT disabled FROM accounts WHERE id=?').get(userId);
        if (!user || user.disabled) throw fail(403, '账号不存在或已停用');
        if (db.prepare('SELECT 1 FROM qq_bindings WHERE user_id=? OR qq=?').get(userId, qq)) throw fail(409, '账号或QQ已经绑定，不能抢占');
        const count = db.prepare('SELECT count(*) AS n FROM binding_challenges WHERE user_id=? AND created_at>?').get(userId, at - 600000).n;
        if (count >= 5) throw fail(429, '验证申请过于频繁，请稍后重试');
        run('UPDATE binding_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL', at, userId);
        const code = crypto.randomBytes(9).toString('base64url'), expiresAt = at + 600000;
        run('INSERT INTO binding_challenges VALUES (?,?,?,?,?,?,?,?)', crypto.randomBytes(16).toString('hex'), userId, qq, digest(code), at, expiresAt, 0, null);
        bump(); return { qq, code, command: '绑定 ' + code, expiresAt };
      });
    },
    consumeBinding(qq, code) {
      qqOf(qq);
      return transaction(() => {
        const at = now();
        if (db.prepare('SELECT 1 FROM qq_bindings WHERE qq=?').get(qq)) return { ok: false, error: '该QQ已经绑定' };
        const rows = db.prepare('SELECT * FROM binding_challenges WHERE qq=? AND consumed_at IS NULL AND expires_at>? AND attempts<5').all(qq, at);
        const incoming = Buffer.from(digest(code), 'hex');
        const row = rows.find(item => crypto.timingSafeEqual(Buffer.from(item.code_hash, 'hex'), incoming));
        if (!row) { for (const item of rows) run('UPDATE binding_challenges SET attempts=attempts+1 WHERE id=?', item.id); if (rows.length) bump(); return { ok: false, error: '验证码错误或已失效' }; }
        const user = db.prepare('SELECT disabled FROM accounts WHERE id=?').get(row.user_id);
        if (!user || user.disabled || getBinding(row.user_id)) return { ok: false, error: '账号不可绑定' };
        run('INSERT INTO qq_bindings VALUES (?,?,?)', qq, row.user_id, at); run('UPDATE binding_challenges SET consumed_at=? WHERE id=?', at, row.id);
        run('UPDATE account_epochs SET epoch=epoch+1 WHERE account_id=?', row.user_id);
        run('INSERT OR IGNORE INTO managed_conversations VALUES (?,?,?)', 'primary', 'private:' + qq, at); bump();
        return { ok: true, binding: { qq, userId: row.user_id, verifiedAt: at } };
      });
    },
    importBundle(input, { dryRun = true } = {}) {
      const bundle = validatePlatformAccountBundle(input), fingerprint = digest(JSON.stringify(bundle));
      const counts = { accounts: bundle.auth.users.length, sessions: bundle.auth.sessions.length, scopes: bundle.auth.users.reduce((n, user) => n + platformBotScopes(user).length, 0), bindings: bundle.bindings.length, challenges: bundle.challenges.length, delegations: bundle.delegations.length, conversations: bundle.conversations.length };
      if (dryRun) return { ok: true, dryRun: true, counts };
      return transaction(() => {
        const previous = db.prepare('SELECT digest,counts_json FROM account_imports WHERE source_id=?').get(bundle.sourceId);
        if (previous) { if (previous.digest !== fingerprint) throw fail(409, '迁移来源已导入且内容不同，禁止覆盖新数据'); return { ok: true, alreadyImported: true, counts: JSON.parse(previous.counts_json) }; }
        if (readAuth()) throw fail(409, '目标平台已有账号，禁止用旧快照覆盖');
        writeAuth(JSON.stringify(bundle.auth), null);
        for (const row of bundle.bindings) { run('INSERT INTO qq_bindings VALUES (?,?,?)', row.qq, row.userId, row.verifiedAt); run('INSERT OR IGNORE INTO managed_conversations VALUES (?,?,?)', 'primary', 'private:' + row.qq, row.verifiedAt); }
        for (const row of bundle.challenges) run('INSERT INTO binding_challenges VALUES (?,?,?,?,?,?,?,?)', row.id, row.userId, row.qq, row.codeHash, row.createdAt, row.expiresAt, row.attempts, row.consumedAt);
        for (const row of bundle.delegations) this.grant(row.userId, row.key, row.botId);
        for (const row of bundle.conversations) run('INSERT OR IGNORE INTO managed_conversations VALUES (?,?,?)', row.botId, row.key, now());
        run('INSERT INTO account_imports VALUES (?,?,?,?)', bundle.sourceId, fingerprint, JSON.stringify(counts), now());
        return { ok: true, dryRun: false, counts };
      });
    },
    close() { db.close(); }
  };
}
