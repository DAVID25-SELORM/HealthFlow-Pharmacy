param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$EnrollmentToken
)

$ErrorActionPreference = 'Stop'
$enrollmentDir = Join-Path $InstallRoot 'workstation-enrollment'
$bundlePath = Join-Path $InstallRoot 'HealthFlow-Connect-This-Computer.zip'
if (-not (Test-Path -LiteralPath $enrollmentDir -PathType Container)) {
  throw "Workstation enrollment directory not found: $enrollmentDir"
}
Set-Content `
  -LiteralPath (Join-Path $enrollmentDir 'enrollment-token.txt') `
  -Value $EnrollmentToken `
  -Encoding ASCII
if (Test-Path -LiteralPath $bundlePath) {
  Remove-Item -LiteralPath $bundlePath -Force
}
Compress-Archive -Path (Join-Path $enrollmentDir '*') -DestinationPath $bundlePath -Force
Write-Output $bundlePath
