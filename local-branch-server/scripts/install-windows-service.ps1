#Requires -RunAsAdministrator
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$NssmPath = '',
  [string]$NodePath = '',
  [string]$LanHostname = $env:COMPUTERNAME,
  [string]$LanIp = '',
  [switch]$InstallDependencies,
  [switch]$SkipCopy
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceServerDir = Split-Path -Parent $scriptDir
$installer = Join-Path $scriptDir 'install-service.ps1'
$targetServerDir = Join-Path $InstallRoot 'local-branch-server'
$targetDataDir = Join-Path $InstallRoot 'data'
$targetDbPath = Join-Path $targetDataDir 'healthflow-branch.sqlite'
$sourceDataDir = Join-Path $sourceServerDir 'data'
$sourceDbPath = Join-Path $sourceDataDir 'healthflow-branch.sqlite'
$shouldCopySourceDb = (Test-Path -LiteralPath $sourceDbPath) -and -not (Test-Path -LiteralPath $targetDbPath)

if (-not (Test-Path -LiteralPath $installer)) {
  throw "Installer not found: $installer"
}

if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $NodePath = $nodeCommand.Source
  } else {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
      throw 'Node.js is not installed and Windows Package Manager (winget) is unavailable. Install Node.js 20 or newer, then rerun this installer.'
    }

    Write-Host 'Node.js is not installed. Installing the current Node.js LTS runtime...'
    & $winget.Source install `
      --id OpenJS.NodeJS.LTS `
      --exact `
      --silent `
      --accept-package-agreements `
      --accept-source-agreements `
      --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
      throw "Node.js LTS installation failed with exit code $LASTEXITCODE."
    }

    $nodeCandidates = @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )
    $NodePath = $nodeCandidates |
      Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
      Select-Object -First 1
    if (-not $NodePath) {
      throw 'Node.js LTS installation completed, but node.exe could not be located.'
    }
  }
}

$arguments = @(
  '-ExecutionPolicy', 'Bypass',
  '-File', $installer,
  '-InstallRoot', $InstallRoot
)
$arguments += @('-LanHostname', $LanHostname)
if ($LanIp) {
  $arguments += @('-LanIp', $LanIp)
}

if ($NssmPath) {
  $arguments += @('-NssmPath', $NssmPath)
}

$arguments += @('-NodePath', $NodePath)

if ($InstallDependencies) {
  $arguments += '-InstallDependencies'
}

if ($SkipCopy) {
  $arguments += '-SkipCopy'
}

Write-Host "Installing HealthFlow Offline Server as a Windows service..."
Write-Host "Install root: $InstallRoot"
Write-Host "Database:     $targetDbPath"

& powershell @arguments
if ($LASTEXITCODE -ne 0) {
  throw "install-service.ps1 failed with exit code $LASTEXITCODE."
}

if ($shouldCopySourceDb) {
  Write-Host 'Existing local SQLite database found in source folder. Moving a copy into production data path...'
  Stop-Service -Name 'HealthFlowOfflineServer' -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $targetDataDir | Out-Null
  Copy-Item -LiteralPath $sourceDbPath -Destination $targetDbPath -Force
  foreach ($suffix in @('-wal', '-shm')) {
    $sidecar = "$sourceDbPath$suffix"
    if (Test-Path -LiteralPath $sidecar) {
      Copy-Item -LiteralPath $sidecar -Destination "$targetDbPath$suffix" -Force
    }
  }
  Start-Service -Name 'HealthFlowOfflineServer'
}

Write-Host ''
Write-Host 'HealthFlow Offline Server Windows service is installed.'
Write-Host 'Service name: HealthFlowOfflineServer'
Write-Host 'Startup:      Automatic'
Write-Host 'Crash policy: Restart'
Write-Host "App folder:   $targetServerDir"
Write-Host "DB path:      $targetDbPath"
Write-Host "Open POS:     https://$($LanHostname.ToLowerInvariant()):4780"
Write-Host "Connect kit:  $(Join-Path $InstallRoot 'HealthFlow-Connect-This-Computer.zip')"
