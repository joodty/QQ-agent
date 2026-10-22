import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createAdminGateway, requireAccountRole, adminProxyRouteAllowed } from '../src/admin-gateway.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const publicOrigin = 'https://console.example.test:8445';
const consoleToken = 'fixture-console-key-for-testing-only';
test('standalone gateway preserves account authentication and keeps native console access isolated', async t => {
  const state = { role: 'admin', authenticated: true, authFailure: false, authCalls: [], targetCalls: [] };
  const accounts = {
    authenticate(cookie) {
      state.authCalls.push({ cookie });
      if (state.authFailure) throw Object.assign(new Error('Fixture storage unavailable'), { statusCode: 503 });
      return state.authenticated && cookie === 'qq_console_session=fixture-cookie' ? { id: 'fixture-user', role: state.role, disabled: false } : null;
    }, handleHttp: async () => false
  };
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      state.targetCalls.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'fixture-upstream-cookie=secret' });
        res.write('event: fixture\ndata: {}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'fixture-upstream-cookie=secret',
        'x-console-token': consoleToken, authorization: 'fixture-secret', location: 'https://untrusted.example/' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
  });
  const targetPort = await listen(target);
  const gateway = createAdminGateway({ publicOrigin, platformAuth: accounts,
    targetOrigin: `http://127.0.0.1:${targetPort}`, consoleToken, sseRecheckMs: 30, maxBodyBytes: 1024 });
  const port = await gateway.listen(0);
  t.after(async () => { await gateway.close(); await close(target); });
  const request = (url = '/api/status', { method = 'GET', cookie = 'qq_console_session=fixture-cookie', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: {
      host: new URL(publicOrigin).host, ...(cookie ? { cookie } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { origin: publicOrigin, 'content-type': 'application/json' } : {}), ...headers
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });

  await t.test('role verification is reusable while the full console always requires admin', () => {
    assert.equal(requireAccountRole({ ok: true, authenticated: true, user: { id: 'fixture', role: 'user' } }, 'user').role, 'user');
    assert.throws(() => requireAccountRole({ ok: true, authenticated: true, user: { id: 'fixture', role: 'user' } }), error => error.statusCode === 403);
    assert.throws(() => createAdminGateway({ publicOrigin, consoleToken, requiredRole: 'user' }));
    assert.throws(() => createAdminGateway({ publicOrigin, consoleToken, targetOrigin: 'http://external.example' }));
    assert.throws(() => createAdminGateway({ publicOrigin: 'http://console.example', consoleToken }));
    assert.throws(() => createAdminGateway({ publicOrigin, consoleToken: 'short' }));
  });
  await t.test('anonymous requests, including static assets, never reach the new service', async () => {
    assert.equal((await request('/console.html', { cookie: null })).status, 401);
    assert.equal((await request('/app.js', { cookie: null })).status, 401);
    assert.equal(state.targetCalls.length, 0);
  });
  await t.test('ordinary accounts cannot access the native administrator UI or API', async () => {
    state.role = 'user';
    assert.equal((await request('/console.html')).status, 403);
    assert.equal((await request()).status, 403);
    assert.equal(state.targetCalls.length, 0);
    state.role = 'admin';
  });
  await t.test('valid old admin cookies authorize each request without a new account', async () => {
    const calls = state.authCalls.length;
    assert.equal((await request('/console.html')).status, 200);
    assert.equal((await request()).status, 200);
    assert.equal(state.authCalls.length, calls + 2);
    const incoming = state.authCalls.at(-1);
    assert.equal(incoming.cookie, 'qq_console_session=fixture-cookie');
    assert.equal(Object.hasOwn(incoming, 'url'), false, 'authentication is a local call, not legacy HTTP');
  });
  await t.test('forwarding rewrites origin/host, injects only the private token and strips browser credentials', async () => {
    const response = await request('/api/config?token=fixture-attacker&access_token=fixture-attacker', { headers: {
      authorization: 'fixture-untrusted', 'x-console-token': 'fixture-untrusted', 'x-agent-token': 'fixture-untrusted', 'x-agent-call': 'fixture'
    } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-qq-agent-console-mode'], 'restricted-admin');
    const forwarded = state.targetCalls.at(-1);
    assert.equal(forwarded.headers.host, `127.0.0.1:${targetPort}`);
    assert.equal(forwarded.headers.origin, `http://127.0.0.1:${targetPort}`);
    assert.equal(forwarded.headers['x-console-token'], consoleToken);
    assert.equal(forwarded.headers.cookie, undefined);
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers['x-agent-token'], undefined);
    assert.equal(forwarded.headers['x-agent-call'], undefined);
    assert.equal(forwarded.url, '/api/config');
    for (const name of ['set-cookie', 'x-console-token', 'authorization', 'location']) assert.equal(response.headers[name], undefined);
    assert.doesNotMatch(response.body, /fixture-console-key/);
  });
  await t.test('forged Host, Origin, Fetch-Site and unsafe methods fail before proxying', async () => {
    const before = state.targetCalls.length;
    assert.equal((await request('/', { headers: { host: 'untrusted.example:8445' } })).status, 403);
    assert.equal((await request('/', { headers: { origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await request('/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request('/api/config', { method: 'POST', body: {}, headers: { origin: '' } })).status, 403);
    assert.equal((await request('/', { method: 'TRACE' })).status, 405);
    assert.equal(state.targetCalls.length, before);
  });
  await t.test('dangerous process, installation, secrets and unbudgeted paid actions have no public route', async () => {
    const before = state.targetCalls.length;
    for (const url of ['/api/snowluma/launch', '/api/snowluma/stop', '/api/qq-portable/launch', '/api/qq-portable/stop',
      '/api/reset-data', '/api/market/install', '/api/market/publish', '/api/skills/reload', '/api/providers/test-one',
      '/api/providers/test-chat', '/api/providers/test-all', '/api/test/api', '/api/vision/scan', '/api/search-providers/test',
      '/api/memory-files/consolidate', '/api/sessions/fixture/retry', '/api/chats/group_456/send']) {
      assert.equal((await request(url, { method: 'POST', body: {} })).status, 403, url);
    }
    for (const url of ['/api/api-key', '/api/providers/key', '/api/search-key', '/api/onebot-token', '/api/captcha-forward/']) {
      assert.equal((await request(url)).status, 403, url);
    }
    assert.equal(state.targetCalls.length, before);
  });
  await t.test('operational configuration cannot weaken isolation or re-enable unbudgeted background calls', async () => {
    for (const body of [{ server: { token: 'fixture-override' } }, { snowluma: { autoLaunch: true } },
      { extensions: { hotReload: true } }, { proactive: { enabled: true } }, { memory: { consolidateEnabled: true } },
      { proactive: { enabled: 'true' } }, { memory: { consolidateEnabled: 'true' } },
      { webSearch: { enabled: true, provider: 'deepseek', deepseek: { apiKey: 'fixture-key' } } },
      { webSearch: { __replace__: { enabled: true, provider: 'custom' } } },
      { proactive: { __replace__: { enabled: true } } }, { memory: { __replace__: { consolidateEnabled: true } } },
      { webSearch: null }, { memory: null },
      { persona: { executable: 'fixture-command' } }]) {
      assert.equal((await request('/api/config', { method: 'POST', body })).status, 403);
    }
    assert.equal((await request('/api/config', { method: 'POST', body: { persona: { roleText: 'fixture-role' } } })).status, 200);
    assert.equal((await request('/api/config', { method: 'POST', body: { webSearch: { enabled: false } } })).status, 200);
    assert.equal((await request('/api/conversation-archives/select', { method: 'POST', body: { chatKey: 'group:456', archiveId: 'fixture-a', expectedVersion: 1 } })).status, 200);
    assert.equal((await request('/api/production-budgets')).status, 200);
    assert.equal((await request('/api/production-budgets', { method: 'PUT', body: { version: 'fixture-version', defaultDailyLimitCny: 1, overrides: {} } })).status, 200);
  });
  await t.test('malformed and oversized JSON is rejected before reaching the target', async () => {
    const before = state.targetCalls.length;
    assert.equal((await request('/api/config', { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await request('/api/config', { method: 'POST', body: 'x'.repeat(1025) })).status, 413);
    assert.equal((await request('/api/config', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal(state.targetCalls.length, before);
  });
  await t.test('cookie revocation and auth-service failure deny access immediately', async () => {
    const before = state.targetCalls.length;
    state.authenticated = false;
    assert.equal((await request()).status, 401);
    state.authenticated = true; state.authFailure = true;
    assert.equal((await request()).status, 503);
    state.authFailure = false;
    assert.equal(state.targetCalls.length, before);
  });
  await t.test('SSE streams work and are closed when the original cookie is revoked', async () => {
    let stream;
    const ended = new Promise((resolve, reject) => {
      stream = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: {
        host: new URL(publicOrigin).host, cookie: 'qq_console_session=fixture-cookie'
      } }, response => {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['set-cookie'], undefined);
        response.once('data', chunk => { assert.match(chunk.toString(), /event: fixture/); state.authenticated = false; });
        response.once('close', resolve); response.on('error', () => {});
      });
      stream.on('error', reject);
    });
    const timer = setTimeout(() => stream.destroy(new Error('SSE revocation timed out')), 2000);
    try { await ended; } finally { clearTimeout(timer); state.authenticated = true; }
    assert.equal((await request()).status, 200);
  });
  await t.test('unknown routes and unsafe configuration remain fail-closed', () => {
    assert.equal(adminProxyRouteAllowed('POST', '/api/new-paid-endpoint', {}), false);
    assert.equal(adminProxyRouteAllowed('GET', '/api/new-secret-endpoint'), false);
    assert.equal(adminProxyRouteAllowed('POST', '/api/config', JSON.parse('{"__proto__":{}}')), false);
  });
});
