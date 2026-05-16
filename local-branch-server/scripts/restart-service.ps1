#Requires -RunAsAdministrator
param(
  [string]$ServiceName = 'HealthFlowOfflineServer'
)

$ErrorActionPreference = 'Stop'

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
  throw "Service not found: $ServiceName"
}

Write-Host "Restarting service: $ServiceName"
Restart-Service -Name $ServiceName -Force

$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
$service.Refresh()

Write-Host "Service status: $($service.Status)"
