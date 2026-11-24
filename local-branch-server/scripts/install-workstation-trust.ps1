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

# Running the installer again, or a failed earlier run, can leave older copies of this server's facility root in the
# trusted store. Remove them and keep only the one just imported.
function Remove-StaleFacilityRoots {
  param([string]$ServerUrl, [string]$KeepThumbprint)
  if (-not $KeepThumbprint -or $ServerUrl -notmatch '^https://([a-z0-9.-]+):\d+$') { return }
  $rootSubject = "CN=HealthFlow Facility Root - $($Matches[1])"
  $removed = 0
  foreach ($item in @(Get-ChildItem -Path 'Cert:\LocalMachine\Root' -ErrorAction SilentlyContinue)) {
    if ($item.Thumbprint -eq $KeepThumbprint -or $item.Subject -ine $rootSubject) { continue }
    try {
      Remove-Item -LiteralPath $item.PSPath -Force -ErrorAction Stop
      $removed++
    } catch {
      Write-Warning "Could not remove an old HealthFlow certificate ($($item.Thumbprint)): $($_.Exception.Message)"
    }
  }
  if ($removed -gt 0) { Write-Host "Removed $removed old HealthFlow root certificate(s) left by earlier installs." }
}

Remove-StaleFacilityRoots -ServerUrl $serverUrl -KeepThumbprint $certificate.Thumbprint

$deviceDirectory = Join-Path $env:ProgramData 'HealthFlow'
$devicePath = Join-Path $deviceDirectory 'workstation.json'
$existingDevice = $null
if (Test-Path -LiteralPath $devicePath) {
  try { $existingDevice = Get-Content -LiteralPath $devicePath -Raw | ConvertFrom-Json } catch { $existingDevice = $null }
}

function Get-WorkstationEnrollment {
  param([string]$ServerUrl, [string]$EnrollmentToken, $ExistingDevice)
  try {
    $response = Invoke-RestMethod `
      -Uri "$ServerUrl/api/workstations/enroll" `
      -Method Post `
      -ContentType 'application/json' `
      -Body (@{
        enrollmentToken = $EnrollmentToken
        computerName = $env:COMPUTERNAME
      } | ConvertTo-Json) `
      -TimeoutSec 15
    return $response.data
  } catch {
    # An enrollment token works once. When this computer was already enrolled by an earlier install, running
    # the installer again must not fail: keep using that enrollment.
    $statusCode = 0
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    $hasDevice = $ExistingDevice -and $ExistingDevice.workstationId -and $ExistingDevice.workstationSecret
    if ($statusCode -eq 401 -and $hasDevice) {
      Write-Host 'This computer is already enrolled with this branch server; keeping its existing enrollment.'
      return [pscustomobject]@{ id = $ExistingDevice.workstationId; secret = $ExistingDevice.workstationSecret }
    }
    throw
  }
}

$enrollmentToken = (Get-Content -LiteralPath $enrollmentTokenFile -Raw).Trim()
$enrollment = [pscustomobject]@{
  data = (Get-WorkstationEnrollment -ServerUrl $serverUrl -EnrollmentToken $enrollmentToken -ExistingDevice $existingDevice)
}
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

New-Item -ItemType Directory -Force -Path $deviceDirectory | Out-Null
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
