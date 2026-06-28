#Requires -RunAsAdministrator
param(
  [string]$BundleRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$rootCertificate = Join-Path $BundleRoot 'healthflow-facility-root.cer'
$serverUrlFile = Join-Path $BundleRoot 'server-url.txt'
$enrollmentTokenFile = Join-Path $BundleRoot 'enrollment-token.txt'

if (-not (Test-Path -LiteralPath $rootCertificate -PathType Leaf)) {
  throw "Facility root certificate not found: $rootCertificate"
}
if (-not (Test-Path -LiteralPath $serverUrlFile -PathType Leaf)) {
  throw "Server URL file not found: $serverUrlFile"
}
if (-not (Test-Path -LiteralPath $enrollmentTokenFile -PathType Leaf)) {
  throw "Enrollment token file not found: $enrollmentTokenFile"
}

$serverUrl = (Get-Content -LiteralPath $serverUrlFile -Raw).Trim()
if ($serverUrl -notmatch '^https://[a-z0-9.-]+:\d+$') {
  throw 'The workstation enrollment bundle contains an invalid HTTPS server URL.'
}

$certificate = Import-Certificate `
  -FilePath $rootCertificate `
  -CertStoreLocation 'Cert:\LocalMachine\Root'

$enrollmentToken = (Get-Content -LiteralPath $enrollmentTokenFile -Raw).Trim()
$enrollment = Invoke-RestMethod `
  -Uri "$serverUrl/api/workstations/enroll" `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{
    enrollmentToken = $enrollmentToken
    computerName = $env:COMPUTERNAME
  } | ConvertTo-Json) `
  -TimeoutSec 15
if (-not $enrollment.data.id -or -not $enrollment.data.secret) {
  throw 'The branch server did not return workstation credentials.'
}

$queryId = [Uri]::EscapeDataString($enrollment.data.id)
$querySecret = [Uri]::EscapeDataString($enrollment.data.secret)
$enrollmentUrl = "$serverUrl/?workstationId=$queryId&workstationSecret=$querySecret"

$shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'HealthFlow Offline POS.url'
$shortcut = @"
[InternetShortcut]
URL=$enrollmentUrl
IconFile=%SystemRoot%\System32\SHELL32.dll
IconIndex=220
"@
Set-Content -LiteralPath $shortcutPath -Value $shortcut -Encoding ASCII

$deviceDirectory = Join-Path $env:ProgramData 'HealthFlow'
New-Item -ItemType Directory -Force -Path $deviceDirectory | Out-Null
$devicePath = Join-Path $deviceDirectory 'workstation.json'
if (-not (Test-Path -LiteralPath $devicePath)) {
  @{
    id = [Guid]::NewGuid().ToString()
    computerName = $env:COMPUTERNAME
    serverUrl = $serverUrl
    workstationId = $enrollment.data.id
    workstationSecret = $enrollment.data.secret
    enrolledAt = (Get-Date).ToUniversalTime().ToString('o')
    rootCertificateThumbprint = $certificate.Thumbprint
  } | ConvertTo-Json | Set-Content -LiteralPath $devicePath -Encoding UTF8
}

Write-Host 'HealthFlow workstation enrollment completed.'
Write-Host "Trusted root: $($certificate.Thumbprint)"
Write-Host "Server URL:  $serverUrl"
Write-Host "Shortcut:    $shortcutPath"
