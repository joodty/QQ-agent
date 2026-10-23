[CmdletBinding()]
param(
    [string]$Path,
    [switch]$Replace,
    [switch]$IncludeSessionToken,
    [string]$CredentialCsvPath
)

# This file can be dot-sourced by a private deployment helper. Its public CLI
# never accepts or emits plaintext credentials, and makes no network requests.
$script:TencentSpeechCredentialRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Assert-TencentSpeechWindows {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'TENCENT_SPEECH_WINDOWS_DPAPI_REQUIRED'
    }
}

function Get-TencentSpeechCredentialPath {
    param([string]$CredentialPath)
    Assert-TencentSpeechWindows
    $privateRoot = [IO.Path]::GetFullPath((Join-Path $script:TencentSpeechCredentialRoot '.local\credentials'))
    if (-not $CredentialPath) { $CredentialPath = Join-Path $privateRoot 'tencent-speech.dpapi.json' }
    $full = [IO.Path]::GetFullPath($CredentialPath)
    if (-not $full.StartsWith($privateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetDirectoryName($full) -ne $privateRoot -or
        -not $full.EndsWith('.dpapi.json', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'TENCENT_SPEECH_PRIVATE_PATH_REQUIRED'
    }
    if ([IO.Path]::GetFileName($full).Contains(':')) { throw 'TENCENT_SPEECH_PRIVATE_PATH_REQUIRED' }
    $probe = $full
    while ($probe) {
        if (Test-Path -LiteralPath $probe) {
            $item = Get-Item -LiteralPath $probe -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'TENCENT_SPEECH_REPARSE_PATH_REJECTED'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($probe)
        if ($parent -eq $probe) { break }
        $probe = $parent
    }
    return $full
}

function Set-TencentSpeechPrivateAcl {
    param([Parameter(Mandatory=$true)][string]$LiteralPath, [switch]$Directory)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    }
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $LiteralPath -AclObject $acl -ErrorAction Stop
}

function Assert-TencentSpeechPrivateAcl {
    param([Parameter(Mandatory=$true)][string]$LiteralPath)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or -not $acl.AreAccessRulesProtected) {
        throw 'TENCENT_SPEECH_PRIVATE_ACL_REQUIRED'
    }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) { throw 'TENCENT_SPEECH_PRIVATE_ACL_REQUIRED' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -ne $identity.Value -or $rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
            throw 'TENCENT_SPEECH_PRIVATE_ACL_REQUIRED'
        }
    }
}

function Get-TencentSpeechCredentialSecure {
    [CmdletBinding()]
    param([string]$Path)
    $full = Get-TencentSpeechCredentialPath $Path
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'TENCENT_SPEECH_CREDENTIAL_NOT_FOUND' }
    Assert-TencentSpeechPrivateAcl $full
    $file = Get-Item -LiteralPath $full -Force
    if ($file.Length -gt 65536) { throw 'TENCENT_SPEECH_INVALID_ENVELOPE' }
    $credentials = @()
    try {
        $envelope = [IO.File]::ReadAllText($full) | ConvertFrom-Json -ErrorAction Stop
        $allowed = @('format','version','protection','credentialFormat','credentialVersion','createdAt','secretIdDpapi','secretKeyDpapi','sessionTokenDpapi')
        foreach ($property in $envelope.PSObject.Properties.Name) {
            if ($property -notin $allowed) { throw 'invalid' }
        }
        if ($envelope.format -ne 'qq-agent-tencent-speech-credential-dpapi' -or $envelope.version -ne 1 -or
            $envelope.protection -ne 'windows-dpapi-current-user' -or
            $envelope.credentialFormat -ne 'qq-agent-tencent-speech-credential' -or $envelope.credentialVersion -ne 1) { throw 'invalid' }
        $result = [ordered]@{format='qq-agent-tencent-speech-credential';version=1}
        foreach ($name in @('secretId','secretKey','sessionToken')) {
            $property = $envelope.PSObject.Properties[$name + 'Dpapi']
            $encrypted = if ($property) { $property.Value } else { $null }
            if (-not $encrypted -and $name -eq 'sessionToken') { continue }
            if ($encrypted -isnot [string] -or $encrypted -notmatch '^[a-fA-F0-9]{100,24000}$') { throw 'invalid' }
            $secure = ConvertTo-SecureString -String $encrypted -ErrorAction Stop
            $credentials += $secure
            if ($secure.Length -lt 16 -or $secure.Length -gt 4096) { throw 'invalid' }
            $result[$name] = $secure
        }
        return [PSCustomObject]$result
    } catch {
        foreach ($secure in $credentials) { $secure.Dispose() }
        throw 'TENCENT_SPEECH_INVALID_OR_UNDECRYPTABLE_ENVELOPE'
    }
}

function Save-TencentSpeechCredentialSecure {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][Security.SecureString]$SecretId,
        [Parameter(Mandatory=$true)][Security.SecureString]$SecretKey,
        [Security.SecureString]$SessionToken,
        [string]$Path,
        [switch]$Replace
    )
    $full = Get-TencentSpeechCredentialPath $Path
    foreach ($secure in @($SecretId, $SecretKey)) {
        if ($secure.Length -lt 16 -or $secure.Length -gt 256) { throw 'TENCENT_SPEECH_INVALID_CREDENTIAL_LENGTH' }
    }
    if ($SessionToken -and ($SessionToken.Length -lt 16 -or $SessionToken.Length -gt 4096)) {
        throw 'TENCENT_SPEECH_INVALID_CREDENTIAL_LENGTH'
    }
    $parent = [IO.Path]::GetDirectoryName($full)
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
        Set-TencentSpeechPrivateAcl $parent -Directory
    }
    Assert-TencentSpeechPrivateAcl $parent
    if (Test-Path -LiteralPath $full) {
        if (-not $Replace) { throw 'TENCENT_SPEECH_CREDENTIAL_ALREADY_EXISTS' }
        $prior = Get-TencentSpeechCredentialSecure $full
        $prior.secretId.Dispose(); $prior.secretKey.Dispose()
        if ($prior.PSObject.Properties['sessionToken']) { $prior.sessionToken.Dispose() }
    }
    $envelope = [ordered]@{
        format='qq-agent-tencent-speech-credential-dpapi';version=1
        protection='windows-dpapi-current-user'
        credentialFormat='qq-agent-tencent-speech-credential';credentialVersion=1
        createdAt=[DateTime]::UtcNow.ToString('o')
        secretIdDpapi=(ConvertFrom-SecureString -SecureString $SecretId -ErrorAction Stop)
        secretKeyDpapi=(ConvertFrom-SecureString -SecureString $SecretKey -ErrorAction Stop)
    }
    if ($SessionToken) { $envelope.sessionTokenDpapi = ConvertFrom-SecureString -SecureString $SessionToken -ErrorAction Stop }
    $temporary = Join-Path $parent ('.tencent-speech-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Dispose()
        Set-TencentSpeechPrivateAcl $temporary
        [IO.File]::WriteAllText($temporary, ($envelope | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        Assert-TencentSpeechPrivateAcl $temporary
        if (Test-Path -LiteralPath $full) {
            [IO.File]::Replace($temporary, $full, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $full)
        }
        Assert-TencentSpeechPrivateAcl $full
        return [PSCustomObject]@{saved=$true;format=$envelope.format;version=1;path=$full;networkVerified=$false}
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop }
    }
}

function Import-TencentSpeechCredentialCsvSecure {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$LiteralPath)
    Assert-TencentSpeechWindows
    $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt 65536 -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'TENCENT_SPEECH_INVALID_CSV_FILE'
    }
    $result = [ordered]@{}
    try {
        $rows = @(Import-Csv -LiteralPath $item.FullName -Encoding UTF8 -ErrorAction Stop)
        if ($rows.Count -ne 1 -or -not $rows[0].SecretId -or -not $rows[0].SecretKey) { throw 'invalid' }
        $result.secretId = ConvertTo-SecureString -String $rows[0].SecretId -AsPlainText -Force
        $result.secretKey = ConvertTo-SecureString -String $rows[0].SecretKey -AsPlainText -Force
        if ($rows[0].PSObject.Properties['SessionToken'] -and $rows[0].SessionToken) {
            $result.sessionToken = ConvertTo-SecureString -String $rows[0].SessionToken -AsPlainText -Force
        }
        return [PSCustomObject]$result
    } catch {
        foreach ($secure in $result.Values) { $secure.Dispose() }
        throw 'TENCENT_SPEECH_INVALID_CSV_FILE'
    } finally {
        $rows = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $id = $null; $key = $null; $token = $null
    try {
        $null = Get-TencentSpeechCredentialPath $Path
        if ($CredentialCsvPath) {
            if ($IncludeSessionToken) { throw 'TENCENT_SPEECH_AMBIGUOUS_INPUT' }
            $imported = Import-TencentSpeechCredentialCsvSecure -LiteralPath $CredentialCsvPath
            $id = $imported.secretId; $key = $imported.secretKey
            if ($imported.PSObject.Properties['sessionToken']) { $token = $imported.sessionToken }
        } else {
            $id = Read-Host 'Tencent TTS SecretId (hidden input)' -AsSecureString
            $key = Read-Host 'Tencent TTS SecretKey (hidden input)' -AsSecureString
            if ($IncludeSessionToken) { $token = Read-Host 'Tencent STS session token (hidden input)' -AsSecureString }
        }
        $saved = Save-TencentSpeechCredentialSecure -SecretId $id -SecretKey $key -SessionToken $token -Path $Path -Replace:$Replace
        Write-Output ('Saved a current-user DPAPI credential: ' + $saved.path)
        Write-Output 'No Tencent API was called. This encrypted Windows file cannot be used directly on Linux.'
    } catch {
        # Never echo the input, serialized envelope, PowerShell invocation or provider errors.
        [Console]::Error.WriteLine('Tencent speech credential was not saved. Inspect path, private ACL and replacement rules; no credential values are printed.')
        exit 1
    } finally {
        foreach ($secure in @($id, $key, $token)) { if ($null -ne $secure) { $secure.Dispose() } }
    }
}
