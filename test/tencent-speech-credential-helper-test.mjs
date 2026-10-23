import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repo, 'scripts/local/Set-TencentSpeechCredential.ps1');
const windows = process.platform === 'win32';
const shell = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;
const fakeId = 'fixture-Tencent-SecretId-for-testing';
const fakeKey = 'fixture-Tencent-SecretKey-for-testing';
const fakeToken = 'fixture-Tencent-SessionToken-for-testing';
const quote = value => `'${value.replaceAll("'", "''")}'`;

function run(body, setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-credential-'));
  const local = path.join(root, 'scripts/local');
  fs.mkdirSync(local, { recursive: true });
  const helper = path.join(local, path.basename(source));
  fs.copyFileSync(source, helper);
  setup?.(root);
  const script = path.join(root, 'fixture.ps1');
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. ${quote(helper)}
$fixtureRoot = ${quote(root)}
$fixtureHelper = ${quote(helper)}
$id = ConvertTo-SecureString ${quote(fakeId)} -AsPlainText -Force
$key = ConvertTo-SecureString ${quote(fakeKey)} -AsPlainText -Force
$token = ConvertTo-SecureString ${quote(fakeToken)} -AsPlainText -Force
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
function Reveal-Fixture($value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
${body}
Write-Output 'fixture-check-ok'
`, 'utf8');
  try {
    // A pwsh 7 parent can otherwise leak its incompatible security-module path
    // into Windows PowerShell 5.1. Use that shell's own built-in modules.
    const env = { ...process.env, PSModulePath: path.join(path.dirname(shell), 'Modules') };
    const child = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 30000, env });
    const output = `${child.stdout || ''}${child.stderr || ''}`;
    const diagnostic = [fakeId, fakeKey, fakeToken].reduce((text, secret) => text.replaceAll(secret, '[fixture-redacted]'), output);
    assert.equal(child.status, 0, diagnostic);
    for (const secret of [fakeId, fakeKey, fakeToken]) assert.equal(output.includes(secret), false, 'helper leaked a fixture credential');
    assert.equal(child.error, undefined, child.error?.message);
    assert.match(child.stdout, /fixture-check-ok/);
    return output;
  } finally {
    // The path was allocated by mkdtemp above and is never computed from user data.
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('credential CLI has no plaintext secret arguments or plaintext export mode', () => {
  const text = fs.readFileSync(source, 'utf8');
  const parameters = text.slice(0, text.indexOf('\n)'));
  assert.doesNotMatch(parameters, /\$(SecretId|SecretKey|SessionToken)\b/i);
  assert.match(text, /Read-Host[^\n]+-AsSecureString/);
  assert.doesNotMatch(text, /Invoke-(WebRequest|RestMethod)|Start-Process|Write-Output[^\n]+(secretIdDpapi|secretKeyDpapi)/i);
});

test('Windows DPAPI helper round-trips credentials and optional STS, using a current-user-only ACL', { skip: !windows && 'Windows current-user DPAPI is required' }, () => {
  run(`
$saved = Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key -SessionToken $token
Assert-True ($saved.saved -and -not $saved.networkVerified) 'save metadata'
Assert-TencentSpeechPrivateAcl $saved.path
Assert-TencentSpeechPrivateAcl ([IO.Path]::GetDirectoryName($saved.path))
$bytes = [IO.File]::ReadAllText($saved.path)
Assert-True (-not $bytes.Contains(${quote(fakeId)}) -and -not $bytes.Contains(${quote(fakeKey)}) -and -not $bytes.Contains(${quote(fakeToken)})) 'plaintext on disk'
$loaded = Get-TencentSpeechCredentialSecure $saved.path
Assert-True ($loaded.format -eq 'qq-agent-tencent-speech-credential' -and $loaded.version -eq 1) 'credential format'
Assert-True ($loaded.secretId -is [Security.SecureString] -and $loaded.secretKey -is [Security.SecureString]) 'secure output'
Assert-True ((Reveal-Fixture $loaded.secretId) -eq ${quote(fakeId)}) 'id mismatch'
Assert-True ((Reveal-Fixture $loaded.secretKey) -eq ${quote(fakeKey)}) 'key mismatch'
Assert-True ((Reveal-Fixture $loaded.sessionToken) -eq ${quote(fakeToken)}) 'token mismatch'
$longToken = ConvertTo-SecureString ('fixture-token-' + ('x' * 4082)) -AsPlainText -Force
Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key -SessionToken $longToken -Replace | Out-Null
$loaded = Get-TencentSpeechCredentialSecure
Assert-True ($loaded.sessionToken.Length -eq 4096) 'maximum token round trip failed'
`);
});

test('existing credentials are preserved by default and replacement validates the original envelope', { skip: !windows && 'Windows current-user DPAPI is required' }, () => {
  run(`
$saved = Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key
$before = [IO.File]::ReadAllText($saved.path)
$rejected = $false
try { Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key | Out-Null } catch { $rejected = $_.Exception.Message -eq 'TENCENT_SPEECH_CREDENTIAL_ALREADY_EXISTS' }
Assert-True $rejected 'existing credential was not protected'
Assert-True ([IO.File]::ReadAllText($saved.path) -eq $before) 'existing bytes changed'
$newKey = ConvertTo-SecureString 'fixture-replacement-key-for-testing' -AsPlainText -Force
Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $newKey -Replace | Out-Null
$loaded = Get-TencentSpeechCredentialSecure $saved.path
Assert-True ((Reveal-Fixture $loaded.secretKey) -eq 'fixture-replacement-key-for-testing') 'replace mismatch'
Assert-True (-not $loaded.PSObject.Properties['sessionToken']) 'unexpected token'
Assert-True (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($saved.path)) -Filter '*.tmp' -Force).Count -eq 0) 'temp leak'
`);
});

test('corrupt envelopes, plaintext fields and non-private ACLs are rejected without replacement', { skip: !windows && 'Windows current-user DPAPI is required' }, () => {
  run(`
$saved = Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key
[IO.File]::WriteAllText($saved.path, '{"format":"unrelated-file"}')
$before = [IO.File]::ReadAllText($saved.path)
$rejected = $false
try { Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key -Replace | Out-Null } catch { $rejected = $true }
Assert-True $rejected 'unknown file overwritten'
Assert-True ([IO.File]::ReadAllText($saved.path) -eq $before) 'unknown bytes changed'
Remove-Item -LiteralPath $saved.path
Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key | Out-Null
$envelope = [IO.File]::ReadAllText($saved.path) | ConvertFrom-Json
$envelope | Add-Member -NotePropertyName secretKey -NotePropertyValue 'fixture-unexpected-plaintext-for-testing'
[IO.File]::WriteAllText($saved.path, ($envelope | ConvertTo-Json))
$rejected = $false
try { Get-TencentSpeechCredentialSecure $saved.path | Out-Null } catch { $rejected = $true }
Assert-True $rejected 'plaintext envelope accepted'
Remove-Item -LiteralPath $saved.path
Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key | Out-Null
$acl = New-Object Security.AccessControl.FileSecurity
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current, 'FullControl', 'Allow')))
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'Read', 'Allow')))
[IO.File]::SetAccessControl($saved.path, $acl)
$rejected = $false
try { Get-TencentSpeechCredentialSecure $saved.path | Out-Null } catch { $rejected = $_.Exception.Message -eq 'TENCENT_SPEECH_PRIVATE_ACL_REQUIRED' }
Assert-True $rejected 'public ACL accepted'
`);
});

test('escaped paths and reparse directories are refused before any credential write', { skip: !windows && 'Windows current-user DPAPI is required' }, () => {
  run(`
$outside = Join-Path $fixtureRoot 'outside.dpapi.json'
$rejected = $false
try { Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key -Path $outside | Out-Null } catch { $rejected = $_.Exception.Message -eq 'TENCENT_SPEECH_PRIVATE_PATH_REQUIRED' }
Assert-True ($rejected -and -not (Test-Path -LiteralPath $outside)) 'escaped path was written'
$local = Join-Path $fixtureRoot '.local'
$target = Join-Path $fixtureRoot 'junction-target'
New-Item -ItemType Directory -Path $local, $target -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $local 'credentials') -Target $target | Out-Null
$rejected = $false
try { Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key | Out-Null } catch { $rejected = $_.Exception.Message -eq 'TENCENT_SPEECH_REPARSE_PATH_REJECTED' }
Assert-True $rejected 'reparse directory accepted'
Assert-True (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) 'reparse target changed'
Remove-Item -LiteralPath (Join-Path $local 'credentials') -Force
`);
});

test('interactive input is hidden and helper output contains no credential values', { skip: !windows && 'Windows current-user DPAPI is required' }, () => {
  run(`
$global:fixtureAsked = 0
$global:fixtureInputId = $id
$global:fixtureInputKey = $key
function Read-Host { param($Prompt, [switch]$AsSecureString)
    Assert-True $AsSecureString 'input was not hidden'
    $global:fixtureAsked++
    if ($global:fixtureAsked -eq 1) { return $global:fixtureInputId.Copy() }
    return $global:fixtureInputKey.Copy()
}
& $fixtureHelper
Assert-True ($global:fixtureAsked -eq 2) 'unexpected input prompts'
$loaded = Get-TencentSpeechCredentialSecure
Assert-True ((Reveal-Fixture $loaded.secretKey) -eq ${quote(fakeKey)}) 'interactive save failed'
`);
});

test('explicit one-row Tencent CSV is encrypted, malformed and multiple rows are rejected', { skip: !windows && 'Windows current-user DPAPI is required' }, () => {
  run(`
$csv = Join-Path $fixtureRoot 'fixture-download.csv'
[IO.File]::WriteAllText($csv, "SecretId,SecretKey\r\n${fakeId},${fakeKey}\r\n")
& $fixtureHelper -CredentialCsvPath $csv
$loaded = Get-TencentSpeechCredentialSecure
Assert-True ((Reveal-Fixture $loaded.secretId) -eq ${quote(fakeId)}) 'csv id mismatch'
Assert-True (Test-Path -LiteralPath $csv) 'source csv was deleted without authorization'
[IO.File]::WriteAllText($csv, "SecretId,SecretKey\r\n${fakeId},${fakeKey}\r\n${fakeId},${fakeKey}\r\n")
$rejected = $false
try { Import-TencentSpeechCredentialCsvSecure $csv | Out-Null } catch { $rejected = $_.Exception.Message -eq 'TENCENT_SPEECH_INVALID_CSV_FILE' }
Assert-True $rejected 'multiple rows accepted'
[IO.File]::WriteAllText($csv, 'username,password')
$rejected = $false
try { Import-TencentSpeechCredentialCsvSecure $csv | Out-Null } catch { $rejected = $true }
Assert-True $rejected 'invalid columns accepted'
`);
});
