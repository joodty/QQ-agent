import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createPlatformAuth } from '../src/platform-auth.js';
import { createPlatformStore } from '../src/platform-store.js';
import { readLegacyPlatformAccounts } from '../src/platform-auth-import.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const id = value => value.toString(16).padStart(32, '0');
const password = 'Fixture10!';
const origin = 'https://console.example.test:8445';
const cli = path.resolve('scripts/import-platform-accounts.mjs');
const runCli = args => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  return { ...result, output: JSON.parse((result.status === 0 ? result.stdout : result.stderr).trim().split('\n').find(line => line.startsWith('{'))) };
};

async function legacyFixture(file) {
  const at = Date.now(), salt = crypto.randomBytes(16).toString('hex');
  const key = (await promisify(crypto.scrypt)(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
  const tokens = Array.from({ length: 6 }, () => crypto.randomBytes(32).toString('base64url'));
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA application_id=${0x51514254}; PRAGMA user_version=1;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,document_path TEXT,username TEXT,role TEXT,disabled INTEGER,password_algorithm TEXT,password_salt TEXT,password_hash TEXT,password_version INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE auth_sessions(hash TEXT PRIMARY KEY,account_id TEXT,password_version INTEGER,created_at INTEGER,expires_at INTEGER);
    CREATE TABLE account_scopes(account_id TEXT,bot_id TEXT,conversation_key TEXT);
    CREATE TABLE tenant_qq_bindings(qq TEXT,user_id TEXT,verified_at INTEGER);
    CREATE TABLE tenant_binding_challenges(id TEXT,user_id TEXT,qq TEXT,code_hash TEXT,created_at INTEGER,expires_at INTEGER,attempts INTEGER,consumed_at INTEGER);
    CREATE TABLE tenant_delegations(user_id TEXT,bot_id TEXT,conversation_key TEXT);
    CREATE TABLE archive_records(bot_id TEXT,conversation_key TEXT);
    CREATE TABLE tenant_funding(bot_id TEXT,conversation_key TEXT);
    CREATE TABLE tenant_profiles(ciphertext TEXT);
    INSERT INTO tenant_profiles VALUES ('fixture-private-api-ciphertext-for-testing');
  `);
  for (let i = 1; i <= 8; i++) db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id(i), 'private-auth-document', 'fixture' + i, i === 1 ? 'admin' : 'user', i === 8 ? 1 : 0, 'scrypt-v1', salt, key, 3, at - 1000 + i, at - 500 + i);
  for (let i = 0; i < 6; i++) db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,?)').run(digest(tokens[i]), id(i + 1), 3, at - 100, at + 3600000);
  db.prepare('INSERT INTO account_scopes VALUES (?,?,?)').run(id(2), 'primary', 'group:123');
  db.prepare('INSERT INTO account_scopes VALUES (?,?,?)').run(id(3), 'primary', 'private:123');
  db.prepare('INSERT INTO account_scopes VALUES (?,?,?)').run(id(2), 'secondary-retained', 'group:456');
  db.prepare('INSERT INTO tenant_qq_bindings VALUES (?,?,?)').run('789', id(2), at - 100);
  db.prepare('INSERT INTO tenant_binding_challenges VALUES (?,?,?,?,?,?,?,?)').run(id(90), id(4), '654', digest('fixture-code-for-testing'), at - 100, at + 360000, 2, null);
  db.prepare('INSERT INTO tenant_delegations VALUES (?,?,?)').run(id(5), 'primary', 'group:321');
  db.prepare('INSERT INTO archive_records VALUES (?,?)').run('primary', 'group:123');
  db.prepare('INSERT INTO archive_records VALUES (?,?)').run('primary', 'private:123');
  db.prepare('INSERT INTO tenant_funding VALUES (?,?)').run('primary', ''); // Legacy bot-wide funding is not a chat key.
  db.prepare('INSERT INTO tenant_funding VALUES (?,?)').run('primary', 'group:321');
  db.close(); return { tokens, at, salt, key };
}

test('one-time account migration is read-only, private, identity-preserving and independent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-platform-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'legacy.sqlite'), target = path.join(dir, 'platform.sqlite'), bundleFile = path.join(dir, 'private-bundle.json');
  const fixture = await legacyFixture(source), beforeHash = digest(fs.readFileSync(source));
  const bundle = readLegacyPlatformAccounts({ file: source, sourceId: 'fixture-import-source' });
  await t.test('read-only projection preserves all eight identities, six sessions and typed bot scopes', () => {
    assert.equal(bundle.auth.users.length, 8); assert.equal(bundle.auth.sessions.length, 6);
    assert.equal(bundle.auth.users[7].disabled, true); assert.equal(bundle.auth.users[0].role, 'admin');
    assert(bundle.auth.users.every(user => user.password.key === fixture.key && user.passwordVersion === 3));
    assert.deepEqual(bundle.auth.users[1].botScopes, [{ botId: 'primary', key: 'group:123' }, { botId: 'secondary-retained', key: 'group:456' }]);
    assert.deepEqual(bundle.auth.users[2].conversationKeys, ['private:123']);
    assert.equal(bundle.bindings[0].qq, '789'); assert.equal(bundle.challenges[0].attempts, 2);
    assert.equal(bundle.delegations[0].key, 'group:321'); assert.equal(bundle.conversations.length, 3);
    assert.equal(digest(fs.readFileSync(source)), beforeHash);
    assert(!JSON.stringify(bundle).includes('fixture-private-api-ciphertext-for-testing'));
  });
  await t.test('CLI preview creates no target or bundle and emits counts without credentials', () => {
    const result = runCli(['--source-sqlite', source, '--target', target]);
    assert.equal(result.status, 0); assert.equal(result.output.dryRun, true); assert.equal(result.output.counts.accounts, 8);
    assert.equal(fs.existsSync(target), false); assert.equal(fs.existsSync(bundleFile), false);
    assert(!result.stdout.includes(fixture.key)); assert(!result.stdout.includes(source));
    for (const token of fixture.tokens) assert(!result.stdout.includes(token));
  });
  await t.test('CLI private bundle and atomic apply preserve cookies and original password login', async () => {
    const result = runCli(['--source-sqlite', source, '--source-id', 'fixture-import-source', '--write-bundle', bundleFile, '--target', target, '--apply']);
    assert.equal(result.status, 0); assert.equal(result.output.counts.sessions, 6);
    assert.deepEqual(JSON.parse(fs.readFileSync(bundleFile, 'utf8')), JSON.parse(JSON.stringify(bundle)));
    const auth = createPlatformAuth({ file: target, publicOrigin: origin });
    try {
      for (let i = 0; i < 6; i++) assert.equal(auth.authenticate('qq_console_session=' + fixture.tokens[i]).id, id(i + 1));
      const user = auth.authenticate('qq_console_session=' + fixture.tokens[1]);
      assert.equal(auth.canAccess(user, 'group:123'), true); assert.equal(auth.canAccess(user, 'private:123'), false);
      assert.equal(auth.canAccess(user, 'group:456', { botId: 'secondary-retained' }), true);
      assert.equal(auth.canUseResourceOwner(id(5), 'group:321'), true);
      assert.equal(auth.canUseResourceOwner(id(8), 'group:123'), false);
      const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('Legacy HTTP must not exist'); };
      try {
        const login = await auth.login({ username: 'fixture2', password }, 'fixture');
        const principal = auth.authenticate(auth.cookie(login.token)); assert.equal(principal.id, id(2));
        await auth.logout(principal); assert.equal(auth.authenticate(auth.cookie(login.token)), null);
      } finally { globalThis.fetch = oldFetch; }
    } finally { auth.close(); }
    assert.equal(digest(fs.readFileSync(source)), beforeHash);
  });
  await t.test('repeated import cannot restore revoked sessions or overwrite newer state', () => {
    const store = createPlatformStore({ file: target });
    try {
      const raw = store.authText(), state = JSON.parse(raw); state.sessions = state.sessions.filter(row => row.hash !== digest(fixture.tokens[0]));
      const revokedUser = state.users.find(row => row.id === id(2)); revokedUser.conversationKeys = []; revokedUser.botScopes = revokedUser.botScopes.filter(scope => scope.botId !== 'primary');
      store.writeAuth(JSON.stringify(state), raw);
      assert.equal(store.importBundle(bundle, { dryRun: false }).alreadyImported, true);
      assert.equal(store.verifiedSession(digest(fixture.tokens[0])), null);
      assert.equal(store.scopeAllowed(id(2), 'group:123'), false, 'repeat import must not restore revoked permissions');
      assert.throws(() => store.importBundle({ ...bundle, sourceId: 'different-source' }, { dryRun: false }), error => error.statusCode === 409);
      const changed = structuredClone(bundle); changed.auth.users[1].username = 'changedfixture';
      assert.throws(() => store.importBundle(changed, { dryRun: false }), error => error.statusCode === 409);
    } finally { store.close(); }
  });
  await t.test('source alias and malformed cross-references are rejected without source changes', () => {
    assert.equal(runCli(['--source-sqlite', source, '--target', source, '--apply']).status, 1);
    const malformed = structuredClone(bundle); malformed.bindings[0].userId = id(99);
    const malformedFile = path.join(dir, 'invalid.json'), absent = path.join(dir, 'absent.sqlite');
    fs.writeFileSync(malformedFile, JSON.stringify(malformed));
    assert.equal(runCli(['--bundle', malformedFile, '--target', absent, '--apply']).status, 1);
    assert.equal(fs.existsSync(absent), false); assert.equal(digest(fs.readFileSync(source)), beforeHash);
  });
});
