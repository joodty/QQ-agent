import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { inspectPlatformFile, checkPlatformPublication } from '../scripts/check-platform-publication.mjs';

test('runtime databases and secret files remain blocked even when they contain binary data', () => {
  for (const name of ['data/config.json', 'data-2/login.bin', '.local/report.json', '.tools/helper.js', 'state/ledger.sqlite', 'private.pem', '.env.production']) {
    assert.ok(inspectPlatformFile(name, Buffer.from([0, 1, 2])).some(row => row.rule === 'private-runtime-file'));
  }
});

test('high-entropy provider credentials are rejected and findings never reveal their value', () => {
  const value = ['sk', 'AbcDefGhiJklMnoPqrStuVwxYz0123456789'].join('-');
  const findings = inspectPlatformFile('src/sample.js', Buffer.from('const key = "' + value + '";'));
  assert.ok(findings.some(row => row.rule === 'provider-credential'));
  assert.ok(!JSON.stringify(findings).includes(value));
});

test('literal passwords and private key headers are rejected', () => {
  const value = ['AbcDefGh', '12345678', 'ZyxWvuTsr'].join('');
  assert.ok(inspectPlatformFile('doc/sample.md', Buffer.from('password: "' + value + '"')).some(row => row.rule === 'literal-credential'));
  const marker = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
  assert.ok(inspectPlatformFile('doc/sample.md', Buffer.from(marker)).some(row => row.rule === 'private-key'));
});

test('local private identifiers are checked without exposing the matching term', () => {
  const value = 'fixture-local-identifier';
  const findings = inspectPlatformFile('doc/sample.md', Buffer.from('Description: ' + value), [value]);
  assert.ok(findings.some(row => row.rule === 'local-private-identifier'));
  assert.ok(!JSON.stringify(findings).includes(value));
});

test('real connection patterns and personal machine paths are rejected while documentation addresses remain usable', () => {
  const address = [8, 8, 4, 4].join('.');
  assert.ok(inspectPlatformFile('doc/sample.md', Buffer.from('ssh root@' + address)).some(row => row.rule === 'server-connection'));
  const personal = ['C:', 'Users', 'fixture-personal-user', 'project'].join('\\');
  assert.ok(inspectPlatformFile('doc/sample.md', Buffer.from(personal)).some(row => row.rule === 'personal-machine-path'));
  assert.deepEqual(inspectPlatformFile('doc/sample.md', Buffer.from('ssh root@192.0.2.10')), []);
});

test('isolated fixtures and generic development instructions do not require real credentials', () => {
  assert.deepEqual(inspectPlatformFile('test/sample.mjs', Buffer.from('const password="fixture-isolated-password";')), []);
  assert.deepEqual(inspectPlatformFile('doc/sample.md', Buffer.from('node --test test/conversation-context-test.mjs')), []);
});

test('worktree, staged bytes and outgoing history are independently checked even after a secret was removed', () => {
  const parent = path.resolve('.local/publication-fixtures'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'fixture-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const commit = message => git(['-c', 'user.name=fixture-user', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message]);
  git(['init', '-b', 'main']); fs.writeFileSync(path.join(dir, '.gitignore'), '.local/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture baseline\n'); git(['add', '.gitignore', 'README.md']); commit('fixture baseline');
  const baseline = git(['rev-parse', 'HEAD']), value = ['sk', 'AbcDefGhiJklMnoPqrStuVwxYz0123456789'].join('-');
  fs.writeFileSync(path.join(dir, 'sample.txt'), value);
  assert.equal(checkPlatformPublication({ workspaceRoot: dir, baseline }).ok, false);
  git(['add', 'sample.txt']); fs.writeFileSync(path.join(dir, 'sample.txt'), 'clean worktree\n');
  assert.equal(checkPlatformPublication({ workspaceRoot: dir, baseline }).ok, true);
  assert.equal(checkPlatformPublication({ workspaceRoot: dir, baseline, staged: true }).ok, false);
  commit('fixture introduced value'); git(['add', 'sample.txt']); commit('fixture removed value');
  assert.equal(checkPlatformPublication({ workspaceRoot: dir, baseline, staged: true }).ok, true);
  const history = checkPlatformPublication({ workspaceRoot: dir, baseline, ref: 'HEAD' });
  assert.equal(history.ok, false); assert.ok(history.findings.some(row => row.rule === 'provider-credential'));
  assert.ok(!JSON.stringify(history).includes(value));
});
