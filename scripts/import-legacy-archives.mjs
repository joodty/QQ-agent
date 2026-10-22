import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConversationArchives } from '../src/conversation-archives.js';

export function importLegacyBundle({ bundleFile, dataDir, apply = false, allowPartial = false }) {
  if (!bundleFile || !dataDir) throw new Error('必须显式提供 --bundle 和 --data-dir');
  const source = path.resolve(bundleFile), target = path.resolve(dataDir, 'conversation-archives.sqlite');
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('导入包必须是小于 256 MiB 的普通 JSON 文件');
  if (source === target) throw new Error('导入源不能是目标数据库');
  const bundle = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  const status = bundle.coverage?.status;
  if (apply && status !== 'complete' && !allowPartial) throw new Error('历史来源不完整或尚未核实。请先预览 coverage；确认接受缺失项后显式使用 --allow-partial');
  const archives = new ConversationArchives({ file: target });
  try {
    const result = archives.importBundle(bundle, { dryRun: !apply });
    return { applied: apply, ...result, coverage: bundle.coverage };
  } finally { archives.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    const names = { '--bundle': 'bundleFile', '--data-dir': 'dataDir' };
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--apply') options.apply = true;
      else if (arg === '--allow-partial') options.allowPartial = true;
      else if (arg === '--dry-run') options.apply = false;
      else if (names[arg] && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[names[arg]] = process.argv[++i];
      else throw new Error('用法：node scripts/import-legacy-archives.mjs --bundle <bundle.json> --data-dir <新系统数据目录> [--dry-run | --apply] [--allow-partial]');
    }
    console.log(JSON.stringify(importLegacyBundle(options), null, 2));
  } catch (error) { console.error('导入失败：' + error.message); process.exitCode = 1; }
}
