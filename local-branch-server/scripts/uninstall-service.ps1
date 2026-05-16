#Requires -RunAsAdministrator
param(
  [string]$InstallRoot = 'C:\HealthFlowPharmacy',
  [string]$NssmPath = '',
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceServerDir = Split-Path -Parent $scriptDir
$sourceRepoRoot = Split-Path -Parent $sourceServerDir
$installServerDir = Join-Path $InstallRoot 'local-branch-server'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'HealthFlow Offline POS.url'
$serviceNames = @('HealthFlowOfflineServer', 'HealthFlowBranchServer', 'HealthFlowBranchSyncWorker')
$oldTaskNames = @('HealthFlow Branch Server', 'HealthFlow Branch Sync Worker')

function Resolve-Nssm {
  if ($NssmPath) {
    $resolved = Resolve-Path -LiteralPath $NssmPath -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path }
    throw "nssm.exe was not found at: $NssmPath"
  }

  $command = Get-Command 'nssm.exe' -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $installServerDir 'deployment\windows\nssm\win64\nssm.exe'),
    (Join-Path $installServerDir 'deployment\windows\nssm\nssm.exe'),
    (Join-Path $InstallRoot 'nssm\nssm.exe'),
    (Join-Path $scriptDir 'nssm.exe'),
    (Join-Path $sourceRepoRoot 'tools\nssm\nssm.exe'),
    (Join-Path $sourceRepoRoot 'tools\nssm\win64\nssm.exe'),
    'C:\nssm\nwin64\nssm.exe',
    'C:\nssm\nssm.exe',
    'C:\Program Files\nssm\nssm.exe',
    'C:\ProgramData\chocolatey\bin\nssm.exe'
  )

  foreach ($candidate in $candidates) {
    $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction SilentlyContinue
    if ($resolved) { return $resolved.Path }
  }

  return ''
}

$nssm = Resolve-Nssm

foreach ($serviceName in $serviceNames) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Host "Service not found: $serviceName"
    continue
  }

  Write-Host "Stopping service: $serviceName"
  if ($nssm) {
    & $nssm stop $serviceName | Out-Null
    Start-Sleep -Seconds 2
    & $nssm remove $serviceName confirm | Out-Null
  } else {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $serviceName | Out-Null
  }

  Write-Host "Removed service: $serviceName"
}

foreach ($taskName in $oldTaskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed old scheduled task: $taskName"
  }
}

if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host "Removed desktop shortcut: $shortcutPath"
}

if ($RemoveFiles) {
  Write-Warning "Removing installed files from $InstallRoot. This also removes local SQLite data, logs, and .env."
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
} else {
  Write-Host "Installed files preserved at: $installServerDir"
  Write-Host 'Use -RemoveFiles only when you intentionally want to delete local data, logs, and .env.'
}

Write-Host ''
Write-Host 'HealthFlow Offline Branch Server service uninstalled.'
