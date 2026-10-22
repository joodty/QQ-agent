#!/usr/bin/env node
// Offline only. Never starts an old runtime or contacts a server/provider.
import fs from 'node:fs';
import path from 'node:path';
import { exportLegacyArchives } from '../src/legacy-archive-export.js';

function argsOf(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') return { help: true };
    if (!['--bridge-root', '--source-id', '--bot-id', '--dsh-exports-dir', '--output'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(result, key)) throw Error('Unknown, duplicated or missing argument: ' + key);
    result[key] = argv[++i];
  }
  for (const key of ['--bridge-root', '--source-id', '--output']) if (!result[key]) throw Error('Required argument: ' + key);
  return result;
}

try {
  const args = argsOf(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/export-legacy-archives.mjs --bridge-root <absolute-offline-copy> --source-id <stable-id> --output <new-private-file> [--bot-id primary] [--dsh-exports-dir <extracted-official-exports>]');
  } else {
    const output = path.resolve(args['--output']), parent = fs.realpathSync(path.dirname(output));
    if (fs.lstatSync(path.dirname(output)).isSymbolicLink()) throw Error('Output parent cannot be a symbolic link');
    for (const value of [args['--bridge-root'], args['--dsh-exports-dir']].filter(Boolean)) {
      const source = fs.realpathSync(value), destination = path.join(parent, path.basename(output));
      const relative = path.relative(source, destination);
      if (relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw Error('Output must be outside all source directories');
    }
    const bundle = exportLegacyArchives({ bridgeRoot: args['--bridge-root'], sourceId: args['--source-id'], botId: args['--bot-id'] || 'primary', ...(args['--dsh-exports-dir'] ? { dshExportsDir: args['--dsh-exports-dir'] } : {}) });
    const fd = fs.openSync(output, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(bundle, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    console.log(JSON.stringify({ ok: true, personas: bundle.personas.length, archives: bundle.archives.length, qqMessages: bundle.archives.reduce((sum, row) => sum + row.messages.length, 0), coverage: bundle.coverage.status, completeDshArchives: bundle.coverage.dshTranscripts.filter(row => row.status === 'complete').length, sourceWritten: false, outputWritten: true }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'EXPORT_FAILED', error: error.message }));
  process.exitCode = 1;
}
