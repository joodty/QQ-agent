// Offline only. Read an authoritative legacy snapshot; never start old services.
// The ledger input must be produced with the original deduplicating daily API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeLegacyBusiness } from '../src/platform-business-import.js';

const error = code => Object.assign(Error(code), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
const roundUp = value => Math.ceil(value * 1000000 - 0.0000001) / 1000000;
const baseName = value => value.replace(/\\/g, '/').split('/').at(-1);

function privateFile(file, maxBytes = 64 * 1024 * 1024) {
  if (!path.isAbsolute(file || '')) throw error('ABSOLUTE_PRIVATE_PATH_REQUIRED');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw error('PRIVATE_SOURCE_FILE_INVALID');
  return file;
}

export function readLegacyBusinessSnapshot({ file } = {}) {
  privateFile(file, Number.MAX_SAFE_INTEGER);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x51514254 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw error('LEGACY_SQLITE_IDENTITY_INVALID');
    db.exec('BEGIN');
    const tenants = db.prepare("SELECT d.* FROM state_documents d JOIN tenant_settings t ON t.document_path=d.path WHERE d.bot_id='primary'").all();
    if (tenants.length !== 1 || typeof tenants[0].raw_text !== 'string') throw error('AUTHORITATIVE_TENANT_DOCUMENT_MISSING');
    const tenant = JSON.parse(tenants[0].raw_text.replace(/^\uFEFF/, ''));
    if (tenant?.version !== 1 || !Array.isArray(tenant.profiles) || !Array.isArray(tenant.funding) || !Array.isArray(tenant.bindings)) throw error('LEGACY_TENANT_FORMAT_INVALID');
    const settings = db.prepare('SELECT * FROM tenant_settings WHERE document_path=?').get(tenants[0].path);
    const profileCount = db.prepare('SELECT count(*) AS n FROM tenant_profiles WHERE document_path=?').get(tenants[0].path).n;
    if (profileCount !== tenant.profiles.length || settings.master_key_id !== tenant.masterKeyId) throw error('LEGACY_TENANT_PROJECTION_MISMATCH');
    const known = new Set(['conversation-budget.json', 'group-budget.json', 'trial-total-quota.json', 'trial-private-quota.json', 'trial-uncertain.json', 'byok-uncertain.json', 'budget-ledger-health.json', 'trial-ledger-health.json']);
    const documents = db.prepare("SELECT path,raw_text FROM state_documents WHERE bot_id='primary'").all().filter(row => known.has(baseName(row.path)));
    const duplicates = new Set(), totals = {}, counts = { documents: 0, tombstones: 0, unresolvedReservations: 0, uncertainCharges: 0, unhealthyLedgers: 0 };
    for (const row of documents) {
      const name = baseName(row.path);
      if (duplicates.has(name)) throw error('LEGACY_DOCUMENT_AMBIGUOUS'); duplicates.add(name);
      counts.documents++;
      if (row.raw_text === null) { counts.tombstones++; continue; } // SQL tombstones never fall back to JSON files.
      const value = JSON.parse(row.raw_text.replace(/^\uFEFF/, ''));
      if (!object(value) || value.version !== 1) throw error('LEGACY_DOCUMENT_VERSION_INVALID');
      if (name === 'budget-ledger-health.json') { if (typeof value.blocked !== 'boolean') throw error('LEGACY_HEALTH_INVALID'); counts.unhealthyLedgers += Number(value.blocked); }
      else if (name === 'trial-ledger-health.json') { if (typeof value.complete !== 'boolean') throw error('LEGACY_HEALTH_INVALID'); counts.unhealthyLedgers += Number(!value.complete); }
      else if (name.endsWith('-uncertain.json')) {
        if (!Array.isArray(value.charges)) throw error('LEGACY_UNCERTAIN_FORMAT_INVALID');
        for (const charge of value.charges) { const amount = charge?.amountCny ?? charge?.amount; if (!money(amount) || !day(charge?.date)) throw error('LEGACY_UNCERTAIN_FORMAT_INVALID'); if (amount > 0) counts.uncertainCharges++; }
      } else {
        if (!Array.isArray(value.reservations) || !Array.isArray(value.days)) throw error('LEGACY_BUDGET_FORMAT_INVALID');
        for (const hold of value.reservations) {
          if (!['active', 'expired', 'settled', 'released'].includes(hold?.state) || !money(hold.amountCny)) throw error('LEGACY_RESERVATION_FORMAT_INVALID');
          if (['active', 'expired'].includes(hold.state)) counts.unresolvedReservations++;
        }
        if (name === 'trial-total-quota.json') for (const row of value.days) {
          if (row?.key !== 'private:1' || !day(row.date) || !money(row.spentCny)) throw error('LEGACY_TRIAL_DAY_INVALID');
          totals[row.date] = Math.max(totals[row.date] || 0, roundUp(row.spentCny));
        }
      }
    }
    db.exec('COMMIT');
    return { tenant, trialDayMinimums: totals, counts };
  } finally { db.close(); }
}

export function assembleLegacyBusinessExport({ snapshot, sourceId, masterKey, ledger } = {}) {
  if (snapshot.counts.unresolvedReservations || snapshot.counts.uncertainCharges) throw error('LEGACY_UNRESOLVED_COSTS');
  if (snapshot.counts.unhealthyLedgers) throw error('LEGACY_LEDGER_UNHEALTHY');
  if (!object(ledger) || ledger.format !== 'qq-bridge-usage-export' || ledger.version !== 1 || ledger.basis !== 'legacy-token-ledger-daily'
    || !Array.isArray(ledger.usage) || ledger.coverage?.currency !== 'CNY' || ledger.coverage?.droppedLines !== 0 || ledger.coverage?.trialComplete !== true || !object(ledger.trialInitialSpent)) throw error('DEDUPLICATED_LEDGER_EXPORT_REQUIRED');
  const trialInitialSpent = { ...snapshot.trialDayMinimums };
  for (const [date, amount] of Object.entries(ledger.trialInitialSpent)) {
    if (!day(date) || !money(amount)) throw error('LEGACY_TRIAL_DAY_INVALID');
    trialInitialSpent[date] = Math.max(trialInitialSpent[date] || 0, roundUp(amount));
  }
  const bundle = normalizeLegacyBusiness({ sourceId, tenant: snapshot.tenant, masterKey, usage: ledger.usage, trialInitialSpent });
  // Keep retired worker credentials as data; never silently enable them for the
  // public bot merely because their original model happens to be approved.
  for (const credential of bundle.credentials) {
    const uses = snapshot.tenant.funding.filter(row => row.profileId === credential.id);
    if (uses.length && uses.every(row => row.botId !== 'primary')) { credential.enabled = false; credential.reason = 'FOREIGN_BOT_DATA_ONLY'; }
  }
  return bundle;
}

async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--bridge-root', '--source-sqlite', '--master-key', '--usage-json', '--source-id', '--output'].includes(flag) || !argv[i + 1] || Object.hasOwn(options, flag)) throw error('INVALID_EXPORT_ARGUMENTS');
    options[flag] = argv[++i];
  }
  if (options['--bridge-root'] && !path.isAbsolute(options['--bridge-root'])) throw error('ABSOLUTE_PRIVATE_PATH_REQUIRED');
  const source = options['--source-sqlite'] || (options['--bridge-root'] && path.join(options['--bridge-root'], 'state', 'manager.sqlite'));
  const snapshot = readLegacyBusinessSnapshot({ file: source });
  const report = { ok: true, dryRun: !options['--output'], readyForBundle: !snapshot.counts.unresolvedReservations && !snapshot.counts.uncertainCharges && !snapshot.counts.unhealthyLedgers, profiles: snapshot.tenant.profiles.length, funding: snapshot.tenant.funding.length, bindings: snapshot.tenant.bindings.length, trialDays: Object.keys(snapshot.trialDayMinimums).length, ...snapshot.counts };
  if (!options['--output']) { process.stdout.write(JSON.stringify(report) + '\n'); return; }
  if (!path.isAbsolute(options['--output']) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(options['--source-id'] || '')) throw error('PRIVATE_OUTPUT_AND_SOURCE_ID_REQUIRED');
  const ledger = JSON.parse(fs.readFileSync(privateFile(options['--usage-json']), 'utf8').replace(/^\uFEFF/, ''));
  const keyFile = options['--master-key'] || (options['--bridge-root'] && path.join(options['--bridge-root'], 'state', 'tenant-key'));
  let masterKey;
  try {
    if (snapshot.tenant.profiles.length) { masterKey = fs.readFileSync(privateFile(keyFile, 32)); if (masterKey.length !== 32) throw error('LEGACY_MASTER_KEY_INVALID'); }
    const bundle = assembleLegacyBusinessExport({ snapshot, sourceId: options['--source-id'], masterKey, ledger });
    fs.writeFileSync(options['--output'], JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ ...report, usageRows: bundle.usage.length, trialDays: Object.keys(bundle.settings.trialInitialSpent).length }) + '\n');
  } finally { masterKey?.fill(0); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(failure => {
  process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(failure.code || '') ? failure.code : 'LEGACY_BUSINESS_EXPORT_FAILED' }) + '\n'); process.exitCode = 1;
});
