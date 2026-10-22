import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readLegacyBusinessSnapshot, assembleLegacyBusinessExport } from '../scripts/export-platform-legacy-business.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cli = path.resolve('scripts/export-platform-legacy-business.mjs');
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-business-export-'));
  const file = path.join(dir, 'state', 'manager.sqlite'); fs.mkdirSync(path.dirname(file));
  const masterKey = crypto.randomBytes(32), iv = crypto.randomBytes(12), ownerId = 'fixture-owner', profileId = 'fixture-profile';
  const apiKey = 'sk-fixture_legacy_business_export_key';
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv); cipher.setAAD(Buffer.from('qq-tenant-profile-v1/' + ownerId + '/' + profileId));
  const encrypted = { version: 1, iv: iv.toString('hex'), ciphertext: Buffer.concat([cipher.update(apiKey), cipher.final()]).toString('hex'), tag: cipher.getAuthTag().toString('hex') };
  const tenant = { version: 1, masterKeyId: hash(masterKey), trial: { version: 1, enabled: true, dailyLimitCny: .1, totalDailyLimitCny: 1 },
    profiles: [{ id: profileId, ownerUserId: ownerId, name: 'Fixture worker profile', provider: 'deepseek', model: 'deepseek-flash', version: 1, enabled: true, deleted: false, invalidReason: null, encrypted }],
    funding: [{ botId: 'worker-fixture', key: null, ownerUserId: ownerId, profileId, version: 1 }],
    bindings: [{ userId: ownerId, qq: '123' }], trialOverrides: [] };
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA application_id=${0x51514254}; PRAGMA user_version=1;
    CREATE TABLE state_documents(path TEXT PRIMARY KEY,kind TEXT,bot_id TEXT,raw_text TEXT);
    CREATE TABLE tenant_settings(document_path TEXT,master_key_id TEXT);
    CREATE TABLE tenant_profiles(document_path TEXT);
  `);
  const put = (name, value) => db.prepare('INSERT OR REPLACE INTO state_documents VALUES (?,?,?,?)').run('state/' + name, name === 'tenants.json' ? 'tenants' : 'json', 'primary', value === null ? null : JSON.stringify(value));
  put('tenants.json', tenant); db.prepare('INSERT INTO tenant_settings VALUES (?,?)').run('state/tenants.json', tenant.masterKeyId); db.prepare('INSERT INTO tenant_profiles VALUES (?)').run('state/tenants.json');
  put('trial-total-quota.json', { version: 1, reservations: [], days: [{ key: 'private:1', date: '2026-10-22', spentCny: .08 }] });
  put('trial-private-quota.json', { version: 1, reservations: [], days: [] });
  put('trial-uncertain.json', { version: 1, charges: [] }); put('byok-uncertain.json', null);
  put('budget-ledger-health.json', { version: 1, blocked: false }); put('trial-ledger-health.json', { version: 1, complete: true });
  fs.writeFileSync(path.join(dir, 'state', 'tenant-key'), masterKey);
  fs.writeFileSync(path.join(dir, 'state', 'tenants.json'), JSON.stringify({ version: 999 })); // Frozen JSON is never authority.
  const ledger = { format: 'qq-bridge-usage-export', version: 1, basis: 'legacy-token-ledger-daily', coverage: { currency: 'CNY', droppedLines: 0, trialComplete: true },
    trialInitialSpent: { '2026-10-22': .01, '2026-10-21': .02000001 }, usage: [{ id: 'fixture-daily-primary-2026-10-22', chatKey: 'private:123', date: '2026-10-22', amountCny: .01000001, botId: 'primary' }] };
  return { dir, file, db, put, masterKey, apiKey, ledger };
};

test('legacy business export uses SQLite authority and preserves original dates and conservative trial minima', t => {
  const f = fixture(); t.after(() => { f.db.close(); f.masterKey.fill(0); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const before = hash(fs.readFileSync(f.file)), snapshot = readLegacyBusinessSnapshot({ file: f.file });
  assert.equal(snapshot.counts.tombstones, 1); assert.equal(snapshot.tenant.profiles.length, 1);
  const result = assembleLegacyBusinessExport({ snapshot, sourceId: 'fixture-source', masterKey: f.masterKey, ledger: f.ledger });
  assert.equal(result.credentials[0].apiKey, f.apiKey); assert.equal(result.credentials[0].enabled, false); assert.equal(result.credentials[0].reason, 'FOREIGN_BOT_DATA_ONLY');
  assert.equal(result.settings.trialInitialSpent['2026-10-22'], .08); assert.equal(result.settings.trialInitialSpent['2026-10-21'], .020001);
  assert.equal(result.usage[0].amountCny, .01000001); assert.equal(result.usage[0].date, '2026-10-22'); assert.equal(hash(fs.readFileSync(f.file)), before);
});

test('unresolved charges, expired holds and unhealthy ledgers refuse export without pretending settlement', t => {
  const f = fixture(); t.after(() => { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const assemble = () => assembleLegacyBusinessExport({ snapshot: readLegacyBusinessSnapshot({ file: f.file }), sourceId: 'fixture-source', masterKey: f.masterKey, ledger: f.ledger });
  f.put('byok-uncertain.json', { version: 1, charges: [{ id: 'fixture-unknown', key: 'private:123', date: '2026-10-21', amount: .01 }] });
  assert.throws(assemble, failure => failure.code === 'LEGACY_UNRESOLVED_COSTS');
  f.put('byok-uncertain.json', null); f.put('trial-private-quota.json', { version: 1, days: [], reservations: [{ state: 'expired', amountCny: .01 }] });
  assert.throws(assemble, failure => failure.code === 'LEGACY_UNRESOLVED_COSTS');
  f.put('trial-private-quota.json', { version: 1, days: [], reservations: [] }); f.put('trial-ledger-health.json', { version: 1, complete: false });
  assert.throws(assemble, failure => failure.code === 'LEGACY_LEDGER_UNHEALTHY');
});

test('authoritative tenant tombstones do not resurrect JSON and raw JSONL is not accepted as a daily export', t => {
  const f = fixture(); t.after(() => { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const snapshot = readLegacyBusinessSnapshot({ file: f.file });
  assert.throws(() => assembleLegacyBusinessExport({ snapshot, sourceId: 'fixture-source', masterKey: f.masterKey, ledger: { usage: f.ledger.usage } }), failure => failure.code === 'DEDUPLICATED_LEDGER_EXPORT_REQUIRED');
  f.put('tenants.json', null); assert.throws(() => readLegacyBusinessSnapshot({ file: f.file }), failure => failure.code === 'AUTHORITATIVE_TENANT_DOCUMENT_MISSING');
});

test('CLI preview does not write or expose secrets; explicit bundle output is private and never overwritten', t => {
  const f = fixture(); f.db.close(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const ledgerFile = path.join(f.dir, 'private-usage.json'), output = path.join(f.dir, 'private-bundle.json'); fs.writeFileSync(ledgerFile, JSON.stringify(f.ledger));
  const before = hash(fs.readFileSync(f.file));
  const run = args => spawnSync(process.execPath, [cli, '--bridge-root', f.dir, ...args], { encoding: 'utf8', timeout: 10000 });
  const preview = run([]); assert.equal(preview.status, 0); assert.equal(fs.existsSync(output), false); assert.equal(JSON.parse(preview.stdout).dryRun, true);
  const args = ['--usage-json', ledgerFile, '--source-id', 'fixture-source', '--output', output];
  const applied = run(args); assert.equal(applied.status, 0); assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).credentials[0].apiKey, f.apiKey);
  assert.equal(run(args).status, 1); assert.equal(hash(fs.readFileSync(f.file)), before);
  for (const result of [preview, applied]) { assert(!result.stdout.includes(f.apiKey)); assert(!result.stdout.includes(f.dir)); assert(!result.stderr.includes(f.apiKey)); }
});
