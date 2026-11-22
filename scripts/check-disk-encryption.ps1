<#
Reports whether the drive that holds the HealthFlow branch server data is encrypted.
Run in an elevated (Administrator) PowerShell on the branch server computer:

  powershell -ExecutionPolicy Bypass -File scripts\check-disk-encryption.ps1

It only reads status. It does not change anything and never prints keys.
#>
param(
  [string]$DataPath = 'C:\HealthFlowLocal\data'
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Run this in an elevated PowerShell (Run as administrator). BitLocker status cannot be read otherwise.' -ForegroundColor Yellow
  exit 2
}

$drive = (Split-Path -Qualifier $DataPath)
if (-not (Test-Path $DataPath)) {
  Write-Host "Note: $DataPath does not exist yet; checking drive $drive anyway." -ForegroundColor Yellow
}

try {
  $volume = Get-BitLockerVolume -MountPoint $drive
} catch {
  Write-Host "Could not read BitLocker status for $drive. This Windows edition may not include BitLocker or Device Encryption." -ForegroundColor Red
  Write-Host 'Result: NOT CONFIRMED ENCRYPTED' -ForegroundColor Red
  exit 1
}

Write-Host "Drive:               $($volume.MountPoint)"
Write-Host "Protection status:   $($volume.ProtectionStatus)"
Write-Host "Volume status:       $($volume.VolumeStatus)"
Write-Host "Encryption percent:  $($volume.EncryptionPercentage)"

if ($volume.ProtectionStatus -eq 'On' -and $volume.VolumeStatus -eq 'FullyEncrypted') {
  Write-Host 'Result: ENCRYPTED' -ForegroundColor Green
  exit 0
}

Write-Host 'Result: NOT FULLY ENCRYPTED. Turn on BitLocker (or Device Encryption) and store the recovery key safely, away from this computer.' -ForegroundColor Red
exit 1
