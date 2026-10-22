[CmdletBinding()]
param(
    [string]$NodePath,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$qqAgentRoot = [IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$qqAgentNodeVersion = '24.22.0'
$qqAgentArchiveName = "node-v$qqAgentNodeVersion-win-x64.zip"
# Fixed official release checksum. A mismatched download is never extracted or run.
$qqAgentArchiveSha = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'

if ($NodePath) {
    $qqAgentNode = (Get-Item -LiteralPath $NodePath -ErrorAction Stop).FullName
} else {
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'The portable bootstrap requires 64-bit Windows; use -NodePath with an existing Node 24 runtime.'
    }
    $qqAgentNode = Join-Path $qqAgentRoot '.tools\node\node.exe'
    $qqAgentToolDir = Join-Path $qqAgentRoot '.tools\node'
    if (-not (Test-Path -LiteralPath $qqAgentNode)) {
        if (Test-Path -LiteralPath $qqAgentToolDir) {
            throw 'An incomplete .tools/node already exists. Inspect it before retrying; no existing tool was overwritten.'
        }
        $qqAgentDownloads = Join-Path $qqAgentRoot '.local\node-downloads'
        New-Item -ItemType Directory -Path $qqAgentDownloads -Force | Out-Null
        $qqAgentArchive = Join-Path $qqAgentDownloads $qqAgentArchiveName
        if (-not (Test-Path -LiteralPath $qqAgentArchive)) {
            $qqAgentOldProgress = $ProgressPreference
            try {
                $ProgressPreference = 'SilentlyContinue'
                Write-Output "Downloading portable Node $qqAgentNodeVersion from nodejs.org..."
                Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$qqAgentNodeVersion/$qqAgentArchiveName" -OutFile $qqAgentArchive -TimeoutSec 180
            } finally {
                $ProgressPreference = $qqAgentOldProgress
            }
        }
        if ((Get-FileHash -LiteralPath $qqAgentArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $qqAgentArchiveSha) {
            throw 'Node archive SHA256 mismatch. Nothing was extracted or executed.'
        }
        $qqAgentExtract = Join-Path $qqAgentDownloads ([Guid]::NewGuid().ToString('N'))
        Expand-Archive -LiteralPath $qqAgentArchive -DestinationPath $qqAgentExtract
        $qqAgentSource = [IO.Path]::GetFullPath((Join-Path $qqAgentExtract "node-v$qqAgentNodeVersion-win-x64"))
        $qqAgentTarget = [IO.Path]::GetFullPath($qqAgentToolDir)
        $qqAgentWorkspacePrefix = $qqAgentRoot.TrimEnd('\') + '\'
        if (-not $qqAgentSource.StartsWith($qqAgentWorkspacePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not $qqAgentTarget.StartsWith($qqAgentWorkspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Portable tool paths escaped this checkout.'
        }
        New-Item -ItemType Directory -Path (Split-Path $qqAgentTarget -Parent) -Force | Out-Null
        Move-Item -LiteralPath $qqAgentSource -Destination $qqAgentTarget
    }
}

$qqAgentNpm = Join-Path (Split-Path $qqAgentNode -Parent) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $qqAgentNpm)) {
    throw 'The selected Node runtime must include npm beside node.exe.'
}
$qqAgentVersion = & $qqAgentNode --version
if ($LASTEXITCODE -ne 0 -or $qqAgentVersion -notmatch '^v24\.') {
    throw 'Use Node 24 for this tested development setup. The global Node runtime was not changed.'
}

$qqAgentOldPath = $env:PATH
$qqAgentOldCache = $env:npm_config_cache
$qqAgentOldDataDir = $env:QQ_AGENT_DATA_DIR
Push-Location $qqAgentRoot
try {
    $env:PATH = (Split-Path $qqAgentNode -Parent) + ';' + $env:PATH
    $env:npm_config_cache = Join-Path $qqAgentRoot '.local\npm-cache'
    $env:QQ_AGENT_DATA_DIR = Join-Path $qqAgentRoot ('.local\bootstrap-data\' + [Guid]::NewGuid().ToString('N'))
    & $qqAgentNode $qqAgentNpm ci --ignore-scripts --no-audit --no-fund --prefer-offline --fetch-retries=1 --fetch-timeout=30000
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Inspect the npm output before retrying.' }

    if (Get-Command git -ErrorAction SilentlyContinue) {
        & git config --local core.hooksPath .githooks
        if ($LASTEXITCODE -ne 0) { throw 'Could not enable this checkout pre-push check.' }
    }
    if (-not $SkipTests) {
        & $qqAgentNode $qqAgentNpm run test:platform
        if ($LASTEXITCODE -ne 0) { throw 'Platform core tests failed.' }
    }
    & $qqAgentNode $qqAgentNpm run check:public
    if ($LASTEXITCODE -ne 0) { throw 'Public source check failed.' }
    Write-Output 'Ready for isolated development. Read AGENTS.md and doc/platform/HANDOFF.md.'
    Write-Output 'No QQ client, model service, desktop app, or production configuration was started.'
    Write-Output 'Run npm test and npm run test:coverage separately for the full upstream baseline.'
} finally {
    $env:PATH = $qqAgentOldPath
    $env:npm_config_cache = $qqAgentOldCache
    $env:QQ_AGENT_DATA_DIR = $qqAgentOldDataDir
    Pop-Location
}
