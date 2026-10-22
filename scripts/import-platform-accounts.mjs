// One-time private import. Defaults to preview and never prints account data.
import fs from 'node:fs';
import path from 'node:path';
import { readLegacyPlatformAccounts, platformAccountImportCounts } from '../src/platform-auth-import.js';
import { createPlatformStore, validatePlatformAccountBundle } from '../src/platform-store.js';

const argv = process.argv.slice(2), options = {};
try {
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--apply') { if (options.apply) throw new Error('Duplicate apply flag'); options.apply = true; continue; }
    if (!['--source-sqlite', '--bundle', '--target', '--source-id', '--write-bundle'].includes(flag) || !argv[index + 1] || Object.hasOwn(options, flag.slice(2))) throw new Error('Invalid private import arguments');
    options[flag.slice(2)] = argv[++index];
  }
  if (Boolean(options['source-sqlite']) === Boolean(options.bundle)) throw new Error('Provide one source-sqlite or private bundle');
  for (const key of ['source-sqlite', 'bundle', 'target', 'write-bundle']) if (options[key] && !path.isAbsolute(options[key])) throw new Error('Private import paths must be absolute');
  if (options.apply) {
    if (!options.target) throw new Error('Applying requires an explicit target platform SQLite file');
    const sourceFile = options['source-sqlite'] || options.bundle;
    const sourceStat = fs.statSync(sourceFile), targetStat = fs.existsSync(options.target) ? fs.statSync(options.target) : null;
    if (path.resolve(sourceFile) === path.resolve(options.target) || targetStat && (fs.realpathSync(sourceFile) === fs.realpathSync(options.target)
      || sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) throw new Error('Source and target must differ');
  }
  const bundle = options.bundle ? validatePlatformAccountBundle(JSON.parse(fs.readFileSync(options.bundle, 'utf8')))
    : readLegacyPlatformAccounts({ file: options['source-sqlite'], sourceId: options['source-id'] || 'legacy-bridge-accounts' });
  if (options['write-bundle']) fs.writeFileSync(options['write-bundle'], JSON.stringify(bundle), { flag: 'wx', mode: 0o600 });
  let result = { ok: true, dryRun: true, counts: platformAccountImportCounts(bundle) };
  if (options.apply) {
    const store = createPlatformStore({ file: options.target });
    try { result = store.importBundle(bundle, { dryRun: false }); } finally { store.close(); }
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, errorType: error.code || error.name || 'Error' })); process.exitCode = 1;
}
