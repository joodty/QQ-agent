// A deployment adapter, not a second account system. The original bridge remains
// authoritative for account cookies and roles; the Agent receives no browser cookie.
import http from 'node:http';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const RESPONSE_HEADERS = new Set(['content-type', 'content-length', 'etag', 'last-modified', 'content-encoding']);
const CONFIG_FIELDS = new Set(['api', 'providers', 'dshProviderKeys', 'persona', 'personaByChat', 'personaUnified',
  'allow', 'deny', 'allowAllWhenEmpty', 'store', 'send', 'memory', 'groupSliderPos', 'unifiedTier', 'chatActive',
  'webSearch', 'proactive', 'tools', 'memberNotes', 'ui', 'peakSchedule', 'security', 'wakeDelayMs', 'drainDelayMs',
  'maxConcurrentRuns', 'sessionRetryAttempts']);

export function requireAccountRole(status, requiredRole = 'admin') {
  if (!['admin', 'user'].includes(requiredRole)) throw new Error('Unsupported required account role');
  if (status?.ok !== true || status.authenticated !== true || !status.user || status.user.disabled === true
      || typeof status.user.id !== 'string' || !status.user.id || status.user.id.length > 200
      || !['admin', 'user'].includes(status.user.role)) throw fail(401, '请先在原管理页面登录账号');
  if (requiredRole === 'admin' && status.user.role !== 'admin') throw fail(403, '此控制台仅向平台管理员开放');
  return { id: status.user.id, role: status.user.role };
}

function loopbackOrigin(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) throw new Error(`${label} must be a fixed loopback HTTP origin`);
  return url;
}

function safeConfigPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !CONFIG_FIELDS.has(key))) return false;
  for (const field of ['proactive', 'memory', 'webSearch']) {
    if (Object.hasOwn(body, field) && (!body[field] || typeof body[field] !== 'object' || Array.isArray(body[field]))) return false;
  }
  if (Object.hasOwn(body.proactive || {}, 'enabled') && body.proactive.enabled !== false) return false;
  if (Object.hasOwn(body.memory || {}, 'consolidateEnabled') && body.memory.consolidateEnabled !== false) return false;
  // Search providers call their own HTTP services outside the model guard. Until
  // that path has a complete pricing policy, the gateway can only turn it off.
  if (body.webSearch && (body.webSearch.enabled !== false || Object.keys(body.webSearch).some(key => key !== 'enabled'))) return false;
  const unsafe = (value, depth = 0) => depth > 30 || value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
    /^(?:path|dir|cwd|command|executable|script|shell|autoLaunch|homeDir|launcherPath|__replace__|__proto__|constructor|prototype)$/i.test(key)
      || unsafe(child, depth + 1));
  return !unsafe(body);
}

export function adminProxyRouteAllowed(method, pathname, body) {
  if (['GET', 'HEAD'].includes(method)) {
    if (!pathname.startsWith('/api/')) return pathname === '/'
      || /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:html|js|css|svg|png|ico|woff2?)$/.test(pathname);
    // Fixed read-only routes. Secret reveal, process controls, captcha forwarding,
    // model tests, search execution and module installation have no gateway route.
    return /^\/api\/(?:status|events|conversation-archives|production-budgets|usage\/(?:stats|breakdown)|model-prices|onebot\/(?:groups|friends)|persona-templates|providers|vision\/results|search-providers|config|community\/blocklist|skills(?:\/capabilities)?|tools(?:\/availability)?|version|chats|sessions(?:\/[\w-]+)?|memory-files(?:\/(?:group|private)_\d+)?|groups\/\d+\/members|chats\/(?:group|private)_\d+\/messages)$/.test(pathname);
  }
  if (method === 'POST') {
    if (pathname === '/api/config') return safeConfigPatch(body);
    return ['/api/conversation-archives/select', '/api/persona-templates', '/api/providers', '/api/providers/models', '/api/providers/set-key'].includes(pathname)
      || /^\/api\/sessions\/[\w-]+\/abort$/.test(pathname)
      || /^\/api\/chats\/(?:group|private)_\d+\/(?:mark-read|mute)$/.test(pathname);
  }
  if (method === 'DELETE') return ['/api/providers', '/api/providers/models'].includes(pathname)
    || /^\/api\/persona-templates\/custom_\d+$/.test(pathname);
  return method === 'PUT' && (pathname === '/api/production-budgets'
    || /^\/api\/memory-files\/(?:group|private)_\d+\/members\/\d+$/.test(pathname));
}

/** No global config imports: construction does not start QQ, models or a console. */
export function createAdminGateway({ publicOrigin, authOrigin = 'http://127.0.0.1:3100',
  targetOrigin = 'http://127.0.0.1:3210', consoleToken, requiredRole = 'admin',
  authTimeoutMs = 3000, upstreamTimeoutMs = 30000, sseRecheckMs = 5000, maxBodyBytes = 2 * 1024 * 1024 } = {}) {
  const publicUrl = new URL(publicOrigin);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/'
      || publicUrl.search || publicUrl.hash) throw new Error('publicOrigin must be an explicit HTTPS origin');
  const authUrl = loopbackOrigin(authOrigin, 'authOrigin');
  const targetUrl = loopbackOrigin(targetOrigin, 'targetOrigin');
  if (typeof consoleToken !== 'string' || consoleToken.length < 24 || consoleToken.length > 256 || /[\r\n]/.test(consoleToken)) throw new Error('A private console token of at least 24 characters is required');
  if (requiredRole !== 'admin') throw new Error('The full Agent console requires the admin role');
  if (!Number.isFinite(sseRecheckMs) || sseRecheckMs < 20) throw new Error('Invalid SSE recheck interval');
  const sockets = new Set();
  const active = new Set();
  const reply = (res, status, message) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify({ ok: false, error: message }));
  };
  const authenticate = cookie => new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/auth/status', authUrl), { method: 'GET', headers: {
      host: authUrl.host, cookie, accept: 'application/json'
    } }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) response.destroy(new Error('Oversized auth response'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(fail(503, '账号服务暂不可用，已停止访问')));
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw fail(503, '账号服务暂不可用，已停止访问');
          resolve(requireAccountRole(JSON.parse(Buffer.concat(chunks).toString('utf8')), requiredRole));
        } catch (error) { reject(error.statusCode ? error : fail(503, '账号服务返回异常，已停止访问')); }
      });
    });
    request.setTimeout(authTimeoutMs, () => request.destroy(new Error('Auth timed out')));
    request.on('error', () => reject(fail(503, '账号服务暂不可用，已停止访问')));
    request.end();
  });
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []; let size = 0, exceeded = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        if (!exceeded) reject(fail(413, '请求内容过大'));
        exceeded = true;
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on('error', () => reject(fail(400, '请求内容无法读取')));
  });
  async function handle(req, res) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw fail(403, '网关仅接受本机反向代理');
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw fail(405, '请求方法未开放');
    if (req.headers.host !== publicUrl.host) throw fail(403, '访问域名不匹配');
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) throw fail(403, '跨站请求被拒绝');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '跨站请求被拒绝');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== publicUrl.origin) throw fail(403, '修改请求必须来自同源控制台');
    if (!req.url.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20]/.test(req.url)) throw fail(400, '无效路径');
    const url = new URL(req.url, publicUrl);
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { throw fail(400, '无效路径编码'); }
    if (decoded.includes('\\') || decoded.includes('%') || decoded.split('/').some(part => part === '.' || part === '..')
        || url.origin !== publicUrl.origin) throw fail(400, '无效路径');
    const cookie = String(req.headers.cookie || '');
    if (!cookie || cookie.length > 8192) throw fail(401, '请先在原管理页面登录账号');
    await authenticate(cookie); // Never infer roles from client headers, query strings or cached UI state.
    let body = null, buffer = null;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail(415, '请求必须使用 JSON');
      buffer = await readBody(req);
      try { body = JSON.parse(buffer.toString('utf8')); } catch { throw fail(400, 'JSON 格式无效'); }
    }
    if (!adminProxyRouteAllowed(req.method, url.pathname, body)) throw fail(403, '该操作未开放；客户端进程、密钥查看和未接入预算的付费操作由服务器管理');
    if (buffer) await authenticate(cookie); // Recheck after a potentially slow upload, before any write.
    // Query-string credentials are browser input, never credentials to the engine.
    for (const name of ['token', 'access_token', 'authorization', 'apiKey']) url.searchParams.delete(name);
    const headers = { host: targetUrl.host, origin: targetUrl.origin, 'x-console-token': consoleToken,
      accept: String(req.headers.accept || '*/*') };
    if (buffer) { headers['content-type'] = 'application/json'; headers['content-length'] = String(buffer.length); }
    const upstream = http.request(new URL(url.pathname + url.search, targetUrl), { method: req.method, headers }, response => {
      const outgoing = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'x-qq-agent-console-mode': 'restricted-admin' };
      for (const [key, value] of Object.entries(response.headers)) if (RESPONSE_HEADERS.has(key) && value !== undefined) outgoing[key] = value;
      const isSse = String(response.headers['content-type'] || '').startsWith('text/event-stream');
      res.writeHead(response.statusCode || 502, outgoing);
      let timer = null, checking = false;
      const cleanup = () => { if (timer) clearInterval(timer); };
      if (isSse) {
        upstream.setTimeout(0);
        timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try { await authenticate(cookie); }
          catch { response.destroy(); res.destroy(); }
          finally { checking = false; }
        }, sseRecheckMs);
        timer.unref?.();
      }
      response.on('error', () => { cleanup(); res.destroy(); });
      response.on('close', cleanup);
      res.on('close', () => { cleanup(); response.destroy(); upstream.destroy(); });
      response.pipe(res);
    });
    active.add(upstream);
    upstream.setTimeout(upstreamTimeoutMs, () => upstream.destroy(new Error('Upstream timed out')));
    upstream.on('error', () => reply(res, 502, '新控制台暂不可用'));
    upstream.on('close', () => active.delete(upstream));
    req.on('aborted', () => upstream.destroy());
    upstream.end(buffer);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => reply(res, error.statusCode || 500, error.statusCode ? error.message : '访问失败'));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return {
    server,
    listen(port = 3211) { return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
    }); },
    async close() {
      for (const request of active) request.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  };
}
