import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createPlatformAuth } from '../src/platform-auth.js';
import { createPlatformStore } from '../src/platform-store.js';

const origin = 'https://console.example.test:8445';
const id = n => n.toString(16).padStart(32, '0');
const password = 'Fixture10!';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-platform-auth-'));
async function fixtureBundle(now) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = (await promisify(crypto.scrypt)(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
  const tokens = Array.from({ length: 6 }, () => crypto.randomBytes(32).toString('base64url'));
  const users = Array.from({ length: 8 }, (_, index) => ({
    id: id(index + 1), username: 'fixture' + index, role: index === 0 ? 'admin' : 'user', disabled: index === 7,
    conversationKeys: index === 1 ? ['group:456'] : [], botScopes: index === 1 ? [{ botId: 'primary', key: 'group:456' }] : [],
    password: { algorithm: 'scrypt-v1', salt, key }, passwordVersion: 2, createdAt: now - 1000 + index, updatedAt: now - 500 + index
  }));
  return { tokens, bundle: { format: 'qq-agent-platform-accounts', version: 1, sourceId: 'fixture-legacy-source',
    auth: { version: 1, users, sessions: tokens.map((token, index) => ({ hash: hash(token), userId: id(index + 1), passwordVersion: 2, createdAt: now - 200, expiresAt: now + 3600000 })) },
    bindings: [{ userId: id(2), qq: '789', verifiedAt: now - 100 }], challenges: [],
    delegations: [{ userId: id(3), botId: 'primary', key: 'private:456' }],
    conversations: [{ botId: 'primary', key: 'group:456' }, { botId: 'primary', key: 'private:456' }]
  } };
}

test('standalone platform accounts preserve legacy identities without a legacy service', async t => {
  const dir = root(), file = path.join(dir, 'platform.sqlite'); let clock = Date.now(), role = 'admin', botInGroup = true, verificationGate = null;
  const { bundle, tokens } = await fixtureBundle(clock);
  const auth = createPlatformAuth({ file, publicOrigin: origin, now: () => clock,
    verifyGroupMember: async ({ groupId, qq }) => { await verificationGate?.(qq); return { group_id: Number(groupId), user_id: Number(qq), role, botInGroup }; } });
  t.after(() => { auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cookie = index => 'qq_console_session=' + tokens[index];
  const principal = index => auth.authenticate(cookie(index));
  await t.test('one-time atomic import preserves eight users, six cookies, password hashes and typed scopes', async () => {
    assert.equal(auth.store.importBundle(bundle).dryRun, true); assert.equal(auth.store.readAuth(), null);
    assert.equal(auth.store.importBundle(bundle, { dryRun: false }).counts.accounts, 8);
    const state = auth.store.readAuth(); assert.equal(state.sessions.length, 6);
    for (const user of state.users) { const source = bundle.auth.users.find(row => row.id === user.id); assert.deepEqual(user.password, source.password); assert.equal(user.passwordVersion, source.passwordVersion); assert.equal(user.disabled, source.disabled); assert.equal(user.role, source.role); }
    for (let index = 0; index < 6; index++) assert.equal(principal(index).id, id(index + 1));
    assert.equal(auth.store.importBundle(bundle, { dryRun: false }).alreadyImported, true);
    assert.equal(auth.canAccess(principal(1), 'group:456'), true); assert.equal(auth.canAccess(principal(1), 'private:456'), false);
    assert.equal(auth.canAccess(principal(2), 'private:456'), true); assert.equal(auth.canAccess(principal(2), 'group:456'), false);
    assert.equal(auth.canAccess(principal(1), 'private:789'), true);
    assert.equal(auth.canAccess({ id: id(2), role: 'admin' }, 'private:999'), false);
    assert.equal(auth.canUseResourceOwner(id(8), 'group:456'), false);
  });
  await t.test('original password login, ten-character policy and revocation work with networking disabled', async () => {
    const previousFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('No external or legacy HTTP allowed'); };
    try {
      const result = await auth.login({ username: 'fixture3', password }, 'fixture');
      const header = auth.cookie(result.token); assert.equal(auth.authenticate(header).id, id(4));
      assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Secure/);
      await auth.logout(auth.authenticate(header)); assert.equal(auth.authenticate(header), null);
      await assert.rejects(auth.register({ username: 'newfixture', password: 'short' }, 'fixture'), /10至128/);
      await assert.rejects(auth.register({ username: 'newfixture', password, role: 'admin' }, 'fixture'), /不能指定身份/);
      const created = await auth.register({ username: 'newfixture', password }, 'fixture');
      const fresh = auth.authenticate(auth.cookie(created.token)); assert.equal(fresh.role, 'user'); assert.deepEqual(auth.listScopes(fresh), []);
      assert.equal(auth.canAccess(fresh, 'private:789'), false);
    } finally { globalThis.fetch = previousFetch; }
  });
  await t.test('password rotation revokes all old cookies and changes only the relevant account permission epoch', async () => {
    const old = principal(3), unaffected = auth.permissionVersion(id(2), 'group:456'), own = auth.permissionVersion(id(4), 'private:123');
    await auth.changePassword(old, { currentPassword: password, newPassword: 'Changed10!' }, 'fixture');
    assert.equal(principal(3), null); assert.equal(auth.canAccess(old, 'private:123'), false);
    assert.equal(auth.permissionVersion(id(2), 'group:456'), unaffected); assert.notEqual(auth.permissionVersion(id(4), 'private:123'), own);
    await assert.rejects(auth.login({ username: 'fixture3', password }, 'fixture'), /账号或密码错误/);
  });
  await t.test('admin scope changes use CAS, revoke stale sessions and detect revoke/regrant ABA', async () => {
    const admin = principal(0), before = auth.permissionVersion(id(2), 'group:456');
    await assert.rejects(auth.updateAccount(admin, { id: id(2), conversationKeys: [], expectedVersion: -1 }), error => error.statusCode === 409);
    await auth.updateAccount(admin, { id: id(2), conversationKeys: [], botScopes: [], expectedVersion: auth.store.version() });
    assert.equal(principal(1), null); assert.equal(auth.canUseResourceOwner(id(2), 'group:456'), false);
    const removed = auth.permissionVersion(id(2), 'group:456'); assert.notEqual(removed, before);
    await auth.updateAccount(admin, { id: id(2), conversationKeys: ['group:456'], expectedVersion: auth.store.version() });
    assert.equal(auth.canUseResourceOwner(id(2), 'group:456'), true); assert.notEqual(auth.permissionVersion(id(2), 'group:456'), removed);
    await assert.rejects(auth.updateAccount(admin, { id: id(1), disabled: true, expectedVersion: auth.store.version() }), /唯一管理员/);
  });
  await t.test('QQ binding requires a trusted private control message and cannot be claimed by a typed number', async () => {
    const user = principal(4), challenge = auth.issueBinding(user, { qq: '456' });
    assert.equal(auth.canUseResourceOwner(user.id, 'private:456'), false);
    assert.equal(auth.consumeBinding({ qq: '456', text: challenge.command }).consumed, false);
    assert.equal(auth.consumeBinding({ private: true, qq: '999', text: challenge.command }).ok, false);
    assert.equal(auth.consumeBinding({ private: true, qq: '456', text: challenge.command }).ok, true);
    assert.equal(auth.canAccess(user, 'private:456'), true);
    assert.throws(() => auth.issueBinding(principal(5), { qq: '456' }), error => error.statusCode === 409);
  });
  await t.test('verified group managers share one resource; TTL, bot membership and role changes are enforced', async () => {
    const user = principal(4); botInGroup = false;
    await assert.rejects(auth.claimGroup(user, { chatKey: 'group:123' }), error => error.statusCode === 403);
    botInGroup = true; await auth.claimGroup(user, { chatKey: 'group:123' });
    assert.equal(auth.canAccess(user, 'group:123'), true); const stamp = auth.permissionVersion(user.id, 'group:123');
    const revision = auth.store.version();
    await auth.login({ username: 'fixture5', password }, 'fixture');
    assert.equal(auth.permissionVersion(user.id, 'group:123'), stamp); assert(auth.store.version() > revision);
    clock += 121000; assert.equal(auth.canAccess(user, 'group:123'), false);
    await auth.refreshGroupPermissions(); assert.equal(auth.canAccess(user, 'group:123'), true); assert.equal(auth.permissionVersion(user.id, 'group:123'), stamp);
    role = 'member'; await auth.refreshGroupPermissions(); assert.equal(auth.canAccess(user, 'group:123'), false);
    assert.notEqual(auth.permissionVersion(user.id, 'group:123'), stamp);
    const relogin = await auth.login({ username: 'fixture4', password }, 'fixture');
    assert.equal(auth.canAccess(auth.authenticate(auth.cookie(relogin.token)), 'group:123'), false, 'logging in must not revive a revoked automatic proof');
    role = 'admin'; await auth.claimGroup(user, { chatKey: 'group:123' });
    const otherChallenge = auth.issueBinding(principal(5), { qq: '123' });
    auth.consumeBinding({ private: true, qq: '123', text: otherChallenge.command });
    await auth.claimGroup(principal(5), { chatKey: 'group:123' });
    assert.equal(auth.store.conversations().filter(key => key === 'group:123').length, 1);
    assert.equal(auth.canAccess(principal(5), 'group:123'), true);
    auth.invalidateGroup({ groupId: '123' }); assert.equal(auth.canAccess(user, 'group:123'), false);
    await auth.ensureAccess(user, 'group:123', { write: true }); assert.equal(auth.canAccess(user, 'group:123'), true);
  });
  await t.test('same-origin HTTP login/status never return password or session secrets', async () => {
    const server = http.createServer((req, res) => auth.handleHttp(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (pathname, method = 'GET', data, requestOrigin = origin) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method,
        headers: { host: new URL(origin).host, origin: requestOrigin, 'content-type': 'application/json' } }, res => {
        const chunks = []; res.on('data', part => chunks.push(part)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
    });
    try {
      assert.equal((await request('/api/auth/status')).status, 200);
      assert.equal((await request('/api/auth/login', 'POST', { username: 'fixture0', password }, 'https://attacker.example')).status, 403);
      const result = await request('/api/auth/login', 'POST', { username: 'fixture0', password });
      assert.equal(result.status, 200); assert(result.headers['set-cookie']);
      const body = JSON.parse(result.body); assert.equal(body.user.role, 'admin');
      assert.equal(body.user.password, undefined); assert.equal(body.user.sessionHash, undefined); assert.equal(body.user.passwordVersion, undefined);
      assert(!result.body.includes(bundle.auth.users[0].password.key));
      assert.equal((await request('/api/auth/bootstrap', 'POST', {})).status, 401);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await t.test('in-flight group checks cannot restore administrator or notice revocations', async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    verificationGate = qq => qq === '456' ? new Promise(resolve => { release = resolve; entered(); }) : null;
    const refresh = auth.refreshGroupPermissions(); await waiting;
    await auth.updateAccount(principal(0), { id: id(5), conversationKeys: [], botScopes: [], expectedVersion: auth.store.version() });
    release(); const refreshed = await refresh; verificationGate = null;
    assert(refreshed.changed >= 1); assert.equal(auth.canUseResourceOwner(id(5), 'group:123'), false);
    const revisionAfterRevoke = auth.store.version();
    assert.equal(auth.invalidateGroup({ groupId: '123', userId: id(5) }), 0);
    assert.equal(auth.store.version(), revisionAfterRevoke, 'an unrelated active manager must not cause a false edit revision');
    const checking = new Promise(resolve => { entered = resolve; });
    verificationGate = qq => qq === '123' ? new Promise(resolve => { release = resolve; entered(); }) : null;
    const claim = auth.claimGroup(principal(5), { chatKey: 'group:123' }); await checking;
    auth.invalidateGroup({ groupId: '123', userId: id(6) }); release();
    await assert.rejects(claim, error => error.statusCode === 409); verificationGate = null;
    assert.equal(auth.canUseResourceOwner(id(6), 'group:123'), false);
  });
});

test('platform SQLite refuses foreign/future databases and stale multi-connection writes', async t => {
  const dir = root(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const foreignFile = path.join(dir, 'foreign.sqlite'), foreign = new DatabaseSync(foreignFile);
  foreign.exec('CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES (\'fixture\')'); foreign.close();
  assert.throws(() => createPlatformStore({ file: foreignFile }), /格式不受支持/);
  const futureFile = path.join(dir, 'future.sqlite'), future = new DatabaseSync(futureFile); future.exec('PRAGMA user_version=999'); future.close();
  assert.throws(() => createPlatformStore({ file: futureFile }), /格式不受支持/);
  const file = path.join(dir, 'accounts.sqlite'), first = createPlatformStore({ file }), second = createPlatformStore({ file });
  try {
    const { bundle } = await fixtureBundle(Date.now()); first.importBundle(bundle, { dryRun: false });
    const raw = first.authText(), state = JSON.parse(raw); state.sessions.pop();
    second.writeAuth(JSON.stringify(state), raw);
    assert.throws(() => first.writeAuth(raw, raw), error => error.statusCode === 409);
    assert.equal(first.readAuth().sessions.length, 5); assert.equal(first.readAuth().users.length, 8);
  } finally { first.close(); second.close(); }
});
