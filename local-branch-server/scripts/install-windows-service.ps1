#Requires -RunAsAdministrator
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$NssmPath = '',
  [string]$NodePath = '',
  [string]$LanHostname = $env:COMPUTERNAME,
  [string]$LanIp = '',
  [switch]$InstallDependencies,
  [switch]$OfflineOnly,
  [switch]$SkipCopy
)

$ErrorActionPreference = 'Stop'

$healthFlowServiceName = 'HealthFlowOfflineServer'
# Checked before any installation step runs (before even the Node.js check
# below). A pre-existing service registration is an installation-state
# signal, not a data-state one: unlike the database file, it is unaffected
# by data being deleted, quarantined, relocated, or pre-seeded, and it
# correctly stays "not fresh" for a reinstall that intentionally preserves
# or restores data. No existing marker distinguishes fresh installs from
# upgrades/repairs more precisely than this across the script chain; a full
# fresh/upgrade/repair/reinstall classification is out of scope here.
$serviceExistedBeforeInstall = [bool](Get-Service -Name $healthFlowServiceName -ErrorAction SilentlyContinue)
$isFreshInstall = -not $serviceExistedBeforeInstall

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
  $bundledNodeCandidates = @(
    (Join-Path $sourceServerDir 'runtime\node\node.exe'),
    (Join-Path $sourceServerDir 'vendor\node\node.exe'),
    (Join-Path $sourceServerDir 'node\node.exe')
  )
  $NodePath = $bundledNodeCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
}

if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $NodePath = $nodeCommand.Source
  } else {
    if ($OfflineOnly) {
      throw 'Node.js runtime is not bundled and is not installed on this computer. Rebuild the HealthFlow installer with the bundled Node runtime before handover.'
    }

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

if ($OfflineOnly) {
  $arguments += '-OfflineOnly'
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

$serverUrl = "https://$($LanHostname.ToLowerInvariant()):4780"

Write-Host ''
Write-Host 'HealthFlow Offline Server Windows service is installed.'
Write-Host 'Service name: HealthFlowOfflineServer'
Write-Host 'Startup:      Automatic'
Write-Host 'Crash policy: Restart'
Write-Host "App folder:   $targetServerDir"
Write-Host "DB path:      $targetDbPath"
Write-Host "Open POS:     $serverUrl"
Write-Host "Connect kit:  $(Join-Path $InstallRoot 'HealthFlow-Connect-This-Computer.zip')"

function Wait-HealthFlowServerReachable {
  param(
    [string]$Url,
    [int]$TimeoutSeconds = 30,
    [int]$IntervalSeconds = 2
  )
  # Reuses the existing /health endpoint — no new endpoint is added. This is
  # deliberately an unauthenticated request: the branch token is never read,
  # sent, or logged here. A 401 from the protected /health route is still a
  # real HTTP response, proving the server process is up and listening, which
  # is all a reachability check needs — full authenticated readiness is out
  # of scope for this ticket. Relies on the facility TLS root already trusted
  # earlier in this same install run (workstation-trust enrollment above),
  # so certificate validation is never disabled.
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
      return $true
    } catch {
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        # The server answered (e.g. 401 with no credentials) — reachable.
        return $true
      }
      # No response at all: connection refused, timeout, or TLS/DNS failure.
      # The server is not yet reachable. Keep polling within the deadline.
    }
    Start-Sleep -Seconds $IntervalSeconds
  } while ((Get-Date) -lt $deadline)
  return $false
}

if ($isFreshInstall) {
  $freshInstallService = Get-Service -Name $healthFlowServiceName -ErrorAction SilentlyContinue
  if (-not $freshInstallService -or $freshInstallService.Status -ne 'Running') {
    $serviceStateDetail = if ($freshInstallService) { $freshInstallService.Status } else { 'not found' }
    Write-Warning "The $healthFlowServiceName service is not running (state: $serviceStateDetail). Skipping automatic launch."
    Write-Warning "Open $serverUrl manually, or double-click the 'HealthFlow Offline POS' desktop shortcut, once the service is running."
  } else {
    Write-Host 'Waiting for the local server to become reachable before opening it...'
    $reachable = Wait-HealthFlowServerReachable -Url "$serverUrl/health" -TimeoutSeconds 30 -IntervalSeconds 2
    if ($reachable) {
      # Reuses the same bare server URL already used for the desktop shortcut
      # and the status line above — no token, no query string, nothing added
      # to the launch target that isn't already public. branch-runtime-
      # config.js supplies the branch identity automatically once the
      # browser loads this origin.
      try {
        Start-Process $serverUrl | Out-Null
        Write-Host 'Opened HealthFlow Offline in your default browser for first-time setup.'
      } catch {
        Write-Warning "Could not open the browser automatically. Open $serverUrl manually, or double-click the 'HealthFlow Offline POS' desktop shortcut, to continue setup."
      }
    } else {
      Write-Warning "The local server did not become reachable within 30 seconds. It may still be starting."
      Write-Warning "Open $serverUrl manually, or double-click the 'HealthFlow Offline POS' desktop shortcut, once it finishes starting."
    }
  }
}
