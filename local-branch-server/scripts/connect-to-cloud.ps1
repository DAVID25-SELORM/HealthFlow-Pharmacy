#Requires -RunAsAdministrator
<#
  Connects this shop computer to HealthFlow Cloud.

  Before running this, in HealthFlow Cloud open Branch Sync Setup, register this computer and press Copy.
  This script takes the copied block (from the -Block parameter, a file, the clipboard, or pasted into the
  window), saves the six connection values into the local server's .env, restarts the HealthFlow service
  and runs the health check. Tokens and keys are never printed.

  -WaitAtEnd keeps the window open until Enter is pressed (used when this opens in its own window, which
  would otherwise close before the result can be read).
#>
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$BlockFile = '',
  [string]$Block = '',
  [string]$ServiceName = 'HealthFlowOfflineServer',
  [switch]$WaitAtEnd
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Exit-Script {
  param([int]$Code)
  if ($WaitAtEnd) {
    Write-Host ''
    [void](Read-Host 'Press Enter to close this window')
  }
  exit $Code
}

function Stop-WithMessage {
  param([string]$Message)
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  Exit-Script 1
}

$serverDir = Join-Path $InstallRoot 'local-branch-server'
$helper = Join-Path $serverDir 'scripts\connect-to-cloud.mjs'

if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
  Stop-WithMessage "HealthFlow is not installed on this computer yet (service $ServiceName was not found). Run Set-Up-HealthFlow-Offline.cmd (or Install-HealthFlow.cmd) first, then run this again."
}
if (-not (Test-Path -LiteralPath $helper)) {
  Stop-WithMessage "The connection helper was not found at $helper. This computer has an older HealthFlow install; reinstall from the latest installer."
}

$nodeExe = Join-Path $serverDir 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (-not $found) { Stop-WithMessage 'Node.js was not found for HealthFlow on this computer.' }
  $nodeExe = $found.Source
}

function Test-LooksLikeSetupBlock {
  param([string]$Text)
  return ($Text -match '(?m)^\s*ORGANIZATION_ID=') -and ($Text -match '(?m)^\s*BRANCH_SYNC_TOKEN=')
}

if (-not $Block) {
  if ($BlockFile) {
    if (-not (Test-Path -LiteralPath $BlockFile)) { Stop-WithMessage "File not found: $BlockFile" }
    $Block = Get-Content -LiteralPath $BlockFile -Raw
  } else {
    try { $Block = [string](Get-Clipboard -Raw) } catch { $Block = '' }
  }
}

if (-not (Test-LooksLikeSetupBlock $Block)) {
  Write-Host 'The clipboard does not hold a HealthFlow setup block.'
  Write-Host 'In HealthFlow Cloud: Branch Sync Setup, register this computer, press Copy.'
  Write-Host 'If you copied it on another computer, paste it here now (right-click), then press Enter on an empty line:'
  $lines = New-Object System.Collections.Generic.List[string]
  while ($true) {
    $line = Read-Host
    if ([string]::IsNullOrWhiteSpace($line)) { break }
    $lines.Add($line)
  }
  $Block = ($lines -join "`n")
}

Write-Host ''
Write-Host 'Saving the cloud connection...'
$Block | & $nodeExe $helper
$saveExit = $LASTEXITCODE
$Block = $null
if ($saveExit -ne 0) {
  Stop-WithMessage 'The cloud connection was not saved. Fix the problem above and run this again.'
}

Write-Host ''
Write-Host 'Restarting the HealthFlow service...'
& (Join-Path $serverDir 'scripts\restart-service.ps1') -ServiceName $ServiceName
Start-Sleep -Seconds 5

Write-Host ''
Write-Host 'Checking the server...'
& (Join-Path $serverDir 'scripts\health-check.ps1') -InstallRoot $InstallRoot
$healthExit = $LASTEXITCODE

Write-Host ''
if ($healthExit -eq 0) {
  Write-Host 'Connected. Open the HealthFlow Offline POS shortcut and sign in; the first sync starts on its own.' -ForegroundColor Green
  Exit-Script 0
} else {
  Write-Host 'The connection was saved but the health check reported a problem (see the FAIL lines above).' -ForegroundColor Yellow
  Write-Host 'The service may still be starting. Wait a minute and run: scripts\health-check.ps1' -ForegroundColor Yellow
  Exit-Script 1
}
