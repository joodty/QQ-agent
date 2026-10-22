// Adapted from joodty/qq-bot publication checks (MIT). Scan this fork's additions,
// not the author's already-public history. Findings never print matching secrets.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_BASELINE = 'fdfd325e148d91845a0aeea3dfdff4cf92fc61a1';
const root = fileURLToPath(new URL('..', import.meta.url));
const names = bytes => bytes.toString('utf8').split('\0').filter(Boolean);
const dummy = value => /(?:fixture|example|dummy|placeholder|for-testing|test[-_])/i.test(value) || new Set(value).size < 5;

export function inspectPlatformFile(name, bytes, terms = []) {
  const result = [], add = (rule, index = 0) => result.push({ file: name, rule, line: bytes.subarray(0, index).toString('utf8').split('\n').length });
  if (/(?:^|\/)(?:\.local|\.tools|node_modules|data(?:-\d+)?|snowluma|runtime|state|backups)(?:\/|$)/i.test(name)
      || /(?:^|\/)(?:config\.json|\.env(?:\..*)?|credentials(?:\..*)?)$/i.test(name)
      || /\.(?:sqlite3?|db|dpapi|pem|key|p12|pfx|log|bak)(?:$|[-.])/i.test(name)) add('private-runtime-file');
  if (bytes.includes(0)) return result;
  const text = bytes.toString('utf8'), at = index => Buffer.byteLength(text.slice(0, index));
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    if (index >= 0) add('local-private-identifier', at(index));
  }
  for (const match of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)) add('private-key', at(match.index));
  for (const match of text.matchAll(/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/g)) {
    if (!dummy(match[0])) add('provider-credential', at(match.index));
  }
  for (const match of text.matchAll(/(?:api[_-]?key|access[_-]?token|machineToken|consoleToken|password|passwd|secret)["']?\s*[:=]\s*(["'])([A-Za-z0-9_./+=-]{16,})\1/gi)) {
    if (!dummy(match[2])) add('literal-credential', at(match.index));
  }
  for (const match of text.matchAll(/https?:\/\/([^\s/:@]+):([^\s/@]+)@/g)) {
    if (!(['user', 'username'].includes(match[1]) && ['pass', 'password'].includes(match[2]))) add('credential-url', at(match.index));
  }
  for (const match of text.matchAll(/\b[A-Za-z]:[\\/]+Users[\\/]+([a-zA-Z0-9_.-]+)/g)) {
    if (!['someone', 'somebody', 'x', 'user', 'username', 'your-user', 'public'].includes(match[1].toLowerCase())) add('personal-machine-path', at(match.index));
  }
  for (const match of text.matchAll(/\b(?:ssh\s+(?:-[^\s]+\s+)*|root@)(?:[a-z0-9_-]+@)?((?:\d{1,3}\.){3}\d{1,3})/gi)) {
    if (!/^(?:127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(match[1])) add('server-connection', at(match.index));
  }
  return result;
}

export function checkPlatformPublication({ staged = false, ref, workspaceRoot = root, baseline = UPSTREAM_BASELINE } = {}) {
  if (staged && ref) throw new Error('Choose staged files or outgoing history');
  const git = args => execFileSync('git', args, { cwd: workspaceRoot, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  let terms = [];
  const privateList = path.join(workspaceRoot, '.local', 'publish-deny.json');
  if (fs.existsSync(privateList)) {
    terms = JSON.parse(fs.readFileSync(privateList, 'utf8')).terms;
    if (!Array.isArray(terms) || terms.some(term => typeof term !== 'string' || term.length < 4)) throw new Error('Invalid local publication denylist');
  }
  const entries = [], findings = [];
  const read = (name, revision) => {
    const rows = revision === ':' ? git(['ls-files', '--stage', '-z', '--', name]) : git(['ls-tree', '-z', revision, '--', name]);
    const mode = rows.toString('utf8').split(' ')[0];
    if (!['100644', '100755'].includes(mode)) findings.push({ file: name, rule: mode === '120000' ? 'symlink' : 'unsupported-git-entry', line: 1 });
    else entries.push([name, git(['show', revision === ':' ? ':' + name : revision + ':' + name])]);
  };
  if (ref) {
    const oid = git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).toString('utf8').trim();
    git(['merge-base', '--is-ancestor', baseline, oid]);
    const commits = git(['rev-list', '--reverse', baseline + '..' + oid]).toString('utf8').trim().split('\n').filter(Boolean);
    for (const commit of commits) for (const name of names(git(['diff', '--name-only', '-z', '--diff-filter=ACMRT', baseline, commit]))) {
      read(name, commit);
    }
  } else if (staged) {
    for (const name of names(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT', baseline]))) read(name, ':');
  } else {
    const changed = names(git(['diff', '--name-only', '-z', '--diff-filter=ACMRT', baseline]));
    for (const name of new Set([...changed, ...names(git(['ls-files', '--others', '--exclude-standard', '-z']))])) {
      const file = path.join(workspaceRoot, name);
      if (fs.lstatSync(file).isSymbolicLink()) findings.push({ file: name, rule: 'symlink', line: 1 });
      else entries.push([name, fs.readFileSync(file)]);
    }
  }
  for (const [name, bytes] of entries) findings.push(...inspectPlatformFile(name, bytes, terms));
  return { ok: findings.length === 0, mode: ref ? 'fork-history' : staged ? 'staged' : 'worktree', files: entries.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === '--staged') && !(args.length === 2 && args[0] === '--ref')) throw new Error('Use --staged or --ref COMMIT');
    const report = checkPlatformPublication({ staged: args.includes('--staged'), ref: args[0] === '--ref' ? args[1] : undefined });
    console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error('Publication check failed: ' + error.message); process.exitCode = 1; }
}
