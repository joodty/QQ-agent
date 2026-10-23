import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createPlatformAuthCore, normalizePlatformScopeKey, platformBotScopes } from './platform-auth-core.js';
import { createPlatformStore } from './platform-store.js';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const COOKIE = 'qq_console_session';
const publicUser = user => {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, disabled: user.disabled,
    conversationKeys: user.conversationKeys, botScopes: user.botScopes, boundQQ: user.boundQQ || null,
    createdAt: user.createdAt, updatedAt: user.updatedAt };
};
const hashCookie = header => {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? crypto.createHash('sha256').update(value).digest('hex') : null;
};

/** Standalone accounts. Every resource check re-reads authoritative SQLite state. */
export function createPlatformAuth({ file, store: suppliedStore, publicOrigin, botId = 'primary', now = Date.now,
  allowRegistration = true, getConversationKeys = () => [], verifyGroupMember = null } = {}) {
  const origin = new URL(publicOrigin);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('An explicit platform HTTPS origin is required');
  const store = suppliedStore || createPlatformStore({ file, now });
  const mutation = new AsyncLocalStorage();
  const storage = {
    readText() { const raw = store.authText(); if (raw === null) throw Object.assign(new Error('No platform accounts yet'), { code: 'ENOENT' }); return raw; },
    writeText(_file, text, expected) { const context = mutation.getStore(); return store.writeAuth(text, expected, context?.expectedVersion, { explicitScopeUsers: context?.explicitScopeUsers || [] }); }
  };
  const core = createPlatformAuthCore({ file: 'platform-accounts', storage, now, allowRegistration });
  core.configured(); // Strict schema/password/session validation, never reset on damage.
  const decorate = user => {
    if (!user) return null;
    const { password, ...principal } = user;
    const binding = store.binding(user.id);
    return { ...principal, boundQQ: binding?.qq || null };
  };
  function verifyPrincipal(principal) {
    if (!principal || principal.kind !== 'session' || typeof principal.sessionHash !== 'string') throw fail(401, '请先登录');
    const fresh = store.verifiedSession(principal.sessionHash);
    if (!fresh || fresh.id !== principal.id || fresh.passwordVersion !== principal.passwordVersion) throw fail(401, '登录已失效，请重新登录');
    return decorate(fresh);
  }
  function ownerCanAccess(userId, key, { botId: wantedBot = botId } = {}) {
    try { key = normalizePlatformScopeKey(key); } catch { return false; }
    return store.readSnapshot(() => {
      const user = store.account(userId);
      if (!user || user.disabled) return false;
      if (user.role === 'admin') return true;
      if (store.scopeAllowed(user.id, key, wantedBot)) return true;
      const binding = wantedBot === botId ? store.binding(userId) : null;
      return !!binding && key === 'private:' + binding.qq;
    });
  }
  function listScopes(principal, { botId: wantedBot = botId } = {}) {
    return store.readSnapshot(() => {
      const fresh = verifyPrincipal(principal);
      const keys = fresh.role === 'admin' ? [...store.conversations(wantedBot), ...getConversationKeys(wantedBot)]
        : platformBotScopes(fresh).filter(scope => scope.botId === wantedBot && store.scopeAllowed(fresh.id, scope.key, wantedBot)).map(scope => scope.key);
      if (fresh.boundQQ && wantedBot === botId) keys.push('private:' + fresh.boundQQ);
      return [...new Set(keys.map(normalizePlatformScopeKey))].sort();
    });
  }
  function currentStatus(principal) {
    let fresh = null;
    if (principal) { try { fresh = verifyPrincipal(principal); } catch {} }
    return { ok: true, configured: core.configured(), registrationEnabled: core.registrationEnabled(), authenticated: !!fresh,
      user: publicUser(fresh), binding: fresh ? store.binding(fresh.id) : null, version: store.version() };
  }
  async function readBody(req) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail(415, '请求必须使用JSON');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw fail(413, '请求过大'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'JSON格式无效'); }
  }
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(JSON.stringify(data));
  };
  const cookie = token => core.cookie(token, origin.protocol === 'https:');
  const clearCookie = () => core.clearCookie(origin.protocol === 'https:');
  const admin = principal => { const fresh = verifyPrincipal(principal); if (fresh.role !== 'admin') throw fail(403, '仅平台管理员可管理账号'); return fresh; };
  const expected = value => { if (!Number.isSafeInteger(value)) throw fail(400, '必须提供当前账号版本 expectedVersion'); return value; };
  async function claimGroup(principal, { chatKey, botId: wantedBot = botId } = {}) {
    const before = verifyPrincipal(principal), key = normalizePlatformScopeKey(chatKey);
    if (!key.startsWith('group:') || wantedBot !== botId) throw fail(400, '只能申请当前机器人的群管理权限');
    if (!before.boundQQ) throw fail(403, '请先验证绑定本人QQ');
    if (typeof verifyGroupMember !== 'function') throw fail(503, '群身份核验暂不可用，请联系平台管理员授权');
    const permission = store.permissionVersion(before.id, key, wantedBot);
    const info = await verifyGroupMember({ botId: wantedBot, groupId: key.slice(6), qq: before.boundQQ });
    const after = verifyPrincipal(principal);
    if (after.boundQQ !== before.boundQQ) throw fail(409, 'QQ绑定在核验期间变化，请重新申请');
    if (!(object(info) && info.botInGroup === true && ['owner', 'admin'].includes(info.role)
      && (info.user_id === undefined || String(info.user_id) === before.boundQQ)
      && (info.group_id === undefined || String(info.group_id) === key.slice(6)))) throw fail(403, '只有机器人已加入且经QQ核验的群主或管理员可管理此群');
    store.grant(after.id, key, wantedBot, { automatic: true, ttlMs: 120000, expectedPermissionVersion: permission });
    return { ok: true, chatKey: key, scopes: listScopes(after), version: store.version() };
  }
  // Default platform subsidy follows real bindings or unrevoked resource
  // grants. A historic conversation/administrator's ability to inspect it is
  // not permission to open spending. Keep account data within this service.
  function defaultFundingAuthorities(chatKey=null,{botId:wantedBot=botId}={}) {
    if(chatKey!==null)chatKey=normalizePlatformScopeKey(chatKey);
    return store.readSnapshot(()=>{
      const candidates=store.db.prepare('SELECT account_id ownerId,conversation_key chatKey FROM account_scopes WHERE bot_id=?'+(chatKey?' AND conversation_key=?':'')+' ORDER BY account_id').all(wantedBot,...(chatKey?[chatKey]:[]));
      if(wantedBot===botId)candidates.push(...store.db.prepare("SELECT user_id ownerId,'private:'||qq chatKey FROM qq_bindings"+(chatKey?" WHERE 'private:'||qq=?":'')+' ORDER BY user_id').all(...(chatKey?[chatKey]:[])));
      const accepted=new Map();
      for(const row of candidates)if(!accepted.has(row.chatKey)&&ownerCanAccess(row.ownerId,row.chatKey,{botId:wantedBot}))accepted.set(row.chatKey,{chatKey:row.chatKey,version:row.ownerId+':'+store.permissionVersion(row.ownerId,row.chatKey,wantedBot)});
      return [...accepted.values()];
    });
  }
  const service = {
    store, publicOrigin: origin.origin, cookie, clearCookie, publicUser,
    authenticate(header) { const hash = hashCookie(header); return hash ? decorate(store.verifiedSession(hash)) : null; },
    verifyPrincipal, listScopes,
    canAccess(principal, key, options) { try { return store.readSnapshot(() => ownerCanAccess(verifyPrincipal(principal).id, key, options)); } catch { return false; } },
    canUseResourceOwner: ownerCanAccess,
    defaultFundingAuthorities,
    permissionVersion(userId, key, { botId: wantedBot = botId } = {}) { return store.permissionVersion(userId, normalizePlatformScopeKey(key), wantedBot); },
    invalidateGroup({ botId: wantedBot = botId, groupId, userId } = {}) { return store.invalidateGroup(wantedBot, groupId, userId); },
    async ensureAccess(principal, key, options = {}) {
      const fresh = verifyPrincipal(principal), normalized = normalizePlatformScopeKey(key), wantedBot = options.botId || botId;
      if (fresh.role === 'admin') return fresh;
      const proof = store.automaticGrants().find(row => row.userId === fresh.id && row.botId === wantedBot && row.key === normalized);
      if (proof) await claimGroup(fresh, { chatKey: normalized, botId: wantedBot });
      if (!service.canAccess(fresh, normalized, options)) throw fail(403, '没有此聊天权限，或QQ群身份需要重新核验');
      return verifyPrincipal(fresh);
    },
    async refreshGroupPermissions() {
      const counts = { checked: 0, valid: 0, revoked: 0, changed: 0 };
      if (typeof verifyGroupMember !== 'function') return counts;
      for (const row of store.automaticGrants()) {
        counts.checked++;
        const account = store.account(row.userId), binding = store.binding(row.userId);
        let info = null;
        if (account && !account.disabled && binding) { try { info = await verifyGroupMember({ botId: row.botId, groupId: row.key.slice(6), qq: binding.qq }); } catch {} }
        try {
        if (info?.botInGroup === true && ['owner', 'admin'].includes(info.role)
          && (info.user_id === undefined || String(info.user_id) === binding?.qq) && (info.group_id === undefined || String(info.group_id) === row.key.slice(6))
          && store.account(row.userId)?.disabled === false && store.binding(row.userId)?.qq === binding?.qq) {
          store.grant(row.userId, row.key, row.botId, { automatic: true, ttlMs: 120000, expectedPermissionVersion: row.permissionVersion }); counts.valid++;
        } else { store.invalidateGroup(row.botId, row.key.slice(6), row.userId, { expectedPermissionVersion: row.permissionVersion }); counts.revoked++; }
        } catch (error) { if (error.statusCode === 409) counts.changed++; else throw error; }
      }
      return counts;
    },
    status: currentStatus,
    bootstrap: (input, remote) => core.bootstrap(input, remote), // Local provisioning only; no public bootstrap route.
    login: (input, remote) => core.login(input, remote), register: (input, remote) => core.register(input, remote),
    logout: principal => core.logout(principal),
    changePassword: (principal, input, remote) => core.changePassword(verifyPrincipal(principal), input, remote),
    accounts(principal) { return core.list(admin(principal)).map(user => publicUser(decorate(user))); },
    createAccount(principal, input) {
      if (!fields(input, ['username', 'password', 'conversationKeys', 'botScopes', 'expectedVersion'])) throw fail(400, '账号创建字段不受支持');
      return mutation.run({ expectedVersion: expected(input.expectedVersion) }, () => core.create(admin(principal), input));
    },
    updateAccount(principal, input) {
      if (!fields(input, ['id', 'username', 'password', 'conversationKeys', 'botScopes', 'disabled', 'expectedVersion'])) throw fail(400, '账号修改字段不受支持');
      const { expectedVersion, ...patch } = input;
      return mutation.run({ expectedVersion: expected(expectedVersion), explicitScopeUsers: Object.hasOwn(patch, 'botScopes') || Object.hasOwn(patch, 'conversationKeys') ? [patch.id] : [] }, () => core.update(admin(principal), patch));
    },
    issueBinding(principal, input) {
      const fresh = verifyPrincipal(principal);
      if (!fields(input, ['qq']) || typeof input.qq !== 'string') throw fail(400, '绑定只接受QQ号码');
      return store.issueBinding(fresh.id, input.qq);
    },
    consumeBinding({ private: isPrivate = false, botId: sourceBot = botId, qq, text } = {}) {
      const match = /^(?:绑定|\/bind)\s+([A-Za-z0-9_-]{12})$/.exec(String(text || '').trim());
      if (!match || !isPrivate || sourceBot !== botId) return { consumed: false };
      try { const result = store.consumeBinding(String(qq), match[1]); return { consumed: true, ok: result.ok, reply: result.ok ? 'QQ绑定成功，现在可以管理本人的私聊设置。' : result.error }; }
      catch { return { consumed: true, ok: false, reply: 'QQ绑定暂时失败，请回控制台检查后重试。' }; }
    },
    claimGroup,
    async handleHttp(req, res, url = new URL(req.url, origin)) {
      const authRoute = url.pathname.startsWith('/api/auth/');
      const ownRoute = authRoute || ['/api/platform/accounts', '/api/platform/binding/status', '/api/platform/binding/issue', '/api/platform/groups/claim'].includes(url.pathname);
      if (!ownRoute) return false;
      try {
        if (req.headers.host !== origin.host || req.headers.origin && req.headers.origin !== origin.origin
          || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '请求来源不被信任');
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin.origin) throw fail(403, '修改请求必须来自同源页面');
        const principal = service.authenticate(String(req.headers.cookie || ''));
        const remote = req.socket.remoteAddress;
        if (req.method === 'GET' && url.pathname === '/api/auth/status') { json(res, 200, currentStatus(principal)); return true; }
        if (req.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(url.pathname)) {
          const input = await readBody(req);
          if (!fields(input, ['username', 'password'])) throw fail(400, '登录或注册只接受账号名与密码');
          const result = await (url.pathname.endsWith('/register') ? core.register(input, remote) : core.login(input, remote));
          const fresh = service.authenticate(cookie(result.token));
          json(res, 200, { ...currentStatus(fresh), ok: true }, { 'set-cookie': cookie(result.token) }); return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/logout') { await core.logout(principal); json(res, 200, { ok: true }, { 'set-cookie': clearCookie() }); return true; }
        const fresh = verifyPrincipal(principal);
        if (req.method === 'POST' && url.pathname === '/api/auth/password') { const result = await service.changePassword(fresh, await readBody(req), remote); json(res, 200, result, { 'set-cookie': clearCookie() }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/platform/accounts') { const accounts = service.accounts(fresh); json(res, 200, { ok: true, accounts, users: accounts, version: store.version() }); return true; }
        if (['POST', 'PUT'].includes(req.method) && url.pathname === '/api/platform/accounts') {
          const input = await readBody(req), account = await (req.method === 'POST' ? service.createAccount(fresh, input) : service.updateAccount(fresh, input));
          json(res, 200, { ok: true, account: publicUser(decorate(account)), version: store.version() }); return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/platform/binding/status') { json(res, 200, { ok: true, binding: store.binding(fresh.id), version: store.version() }); return true; }
        if (req.method === 'POST' && url.pathname === '/api/platform/binding/issue') { json(res, 200, { ok: true, ...service.issueBinding(fresh, await readBody(req)) }); return true; }
        if (req.method === 'POST' && url.pathname === '/api/platform/groups/claim') { json(res, 200, await claimGroup(fresh, await readBody(req))); return true; }
        throw fail(404, '账号接口不存在');
      } catch (error) { json(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : '账号服务暂不可用' }); return true; }
    },
    close() { if (!suppliedStore) store.close(); }
  };
  return service;
}
