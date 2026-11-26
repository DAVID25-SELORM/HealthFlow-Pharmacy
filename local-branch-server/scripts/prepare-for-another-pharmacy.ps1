#Requires -Version 5.1
# Makes an offline computer ready for a different pharmacy. Nothing is deleted: the old pharmacy's records are moved
# into an archive folder that only Windows administrators can open. Run as administrator.
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$ServiceName = 'HealthFlowOfflineServer',
  # Only when the records that never reached the cloud may stay in the archive.
  [switch]$ArchiveUnsyncedRecords
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in PowerShell opened as administrator.'
}

$serverDir = Join-Path $InstallRoot 'local-branch-server'
$nodeExe = Join-Path $serverDir 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (-not $found) { throw 'The HealthFlow Node.js runtime was not found.' }
  $nodeExe = $found.Source
}
$helper = Join-Path $PSScriptRoot 'start-clean.mjs'

& $nodeExe $helper --install-root $InstallRoot --check
if ($LASTEXITCODE -eq 3 -and -not $ArchiveUnsyncedRecords) {
  throw 'Some records have not reached HealthFlow Cloud. Nothing was changed. Let this computer finish syncing first.'
}
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3) { throw 'The records could not be checked. Nothing was changed.' }

Write-Host ''
Write-Host "This stops HealthFlow Offline and moves this pharmacy's records, backups, logs and settings into an archive." -ForegroundColor Yellow
Write-Host 'The computer will then hold no pharmacy until you run the setup with the new pharmacy''s setup code.'
$answer = Read-Host 'Type ARCHIVE to continue'
if ($answer -cne 'ARCHIVE') { throw 'Cancelled. Nothing was changed.' }

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
  Stop-Service -Name $ServiceName -Force
  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
}

$arguments = @($helper, '--install-root', $InstallRoot)
if ($ArchiveUnsyncedRecords) { $arguments += '--allow-unsynced' }
& $nodeExe @arguments
if ($LASTEXITCODE -ne 0) { throw 'The records were not archived. Read the message above.' }

# The archive holds the old pharmacy's patient records, so ordinary Windows users must not open it.
$archiveRoot = Join-Path $InstallRoot 'archive'
& icacls.exe $archiveRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Could not limit who can open $archiveRoot. Set it to Administrators only before the computer is handed over."
}

# The shortcut holds the old registration.
$shortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'HealthFlow Offline POS.url'
Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Done. Next:' -ForegroundColor Green
Write-Host '  1. On every computer that used HealthFlow Offline here, clear the browser''s saved data for this server.'
Write-Host '  2. Run Set-Up-HealthFlow-Offline.cmd with the new pharmacy''s setup code.'
Write-Host "  3. Arrange with the old pharmacy what happens to the archive in $archiveRoot. It is their data."
