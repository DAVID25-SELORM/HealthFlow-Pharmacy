#Requires -RunAsAdministrator
param(
  [string]$InstallRoot = 'C:\HealthFlowLocal',
  [string]$LanHostname = $env:COMPUTERNAME,
  [string]$LanIp = '',
  [int]$RenewBeforeDays = 45,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$serverDir = Join-Path $InstallRoot 'local-branch-server'
$certDir = Join-Path $InstallRoot 'certs'
$enrollmentDir = Join-Path $InstallRoot 'workstation-enrollment'
$envPath = Join-Path $serverDir '.env'
$metadataPath = Join-Path $certDir 'certificate-metadata.json'
$certPath = Join-Path $certDir 'server.crt'
$pfxPath = Join-Path $certDir 'server.pfx'
$rootCerPath = Join-Path $certDir 'healthflow-facility-root.cer'

if (-not $LanHostname -or $LanHostname -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$') {
  throw 'A valid LAN hostname is required for TLS provisioning.'
}
if ($LanIp) {
  try {
    [void][System.Net.IPAddress]::Parse($LanIp)
  } catch {
    throw 'LAN IP address is invalid.'
  }
}
if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Branch server .env not found: $envPath"
}

function Set-EnvValue {
  param([string]$Name, [string]$Value)
  $content = Get-Content -LiteralPath $envPath -Raw
  $line = "$Name=$Value"
  if ($content -match "(?m)^$([regex]::Escape($Name))=.*$") {
    $content = [regex]::Replace($content, "(?m)^$([regex]::Escape($Name))=.*$", $line)
  } else {
    $content = $content.TrimEnd() + "`r`n$line`r`n"
  }
  Set-Content -LiteralPath $envPath -Value $content -Encoding UTF8
}

function Export-PemCertificate {
  param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate, [string]$Path)
  $base64 = [Convert]::ToBase64String($Certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks)
  $pem = "-----BEGIN CERTIFICATE-----`r`n$base64`r`n-----END CERTIFICATE-----`r`n"
  Set-Content -LiteralPath $Path -Value $pem -Encoding ASCII
}

New-Item -ItemType Directory -Force -Path $certDir, $enrollmentDir | Out-Null

$existingMetadata = if (Test-Path -LiteralPath $metadataPath) {
  Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
} else { $null }
$existingServer = if ($existingMetadata.serverThumbprint) {
  Get-Item "Cert:\LocalMachine\My\$($existingMetadata.serverThumbprint)" -ErrorAction SilentlyContinue
} else { $null }
$renewAt = (Get-Date).AddDays($RenewBeforeDays)
$canReuse = -not $Force -and $existingServer -and $existingServer.NotAfter -gt $renewAt -and
  (Test-Path -LiteralPath $certPath) -and (Test-Path -LiteralPath $pfxPath) -and
  (Test-Path -LiteralPath $rootCerPath)
$certificateChanged = -not $canReuse

if (-not $canReuse) {
  $root = if ($existingMetadata.rootThumbprint) {
    Get-Item "Cert:\LocalMachine\My\$($existingMetadata.rootThumbprint)" -ErrorAction SilentlyContinue
  } else { $null }
  if (-not $root -or $root.NotAfter -le (Get-Date).AddYears(2)) {
    $root = New-SelfSignedCertificate `
      -Type Custom `
      -Subject "CN=HealthFlow Facility Root - $LanHostname" `
      -KeyAlgorithm RSA `
      -KeyLength 3072 `
      -HashAlgorithm SHA256 `
      -KeyExportPolicy Exportable `
      -KeyUsage CertSign, CRLSign, DigitalSignature `
      -CertStoreLocation 'Cert:\LocalMachine\My' `
      -NotAfter (Get-Date).AddYears(10) `
      -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1')
  }

  Export-Certificate -Cert $root -FilePath $rootCerPath -Force | Out-Null
  Import-Certificate -FilePath $rootCerPath -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null

  $sanParts = @("dns=$LanHostname")
  if ($LanIp) { $sanParts += "ipaddress=$LanIp" }
  $serverCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=$LanHostname" `
    -Signer $root `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -CertStoreLocation 'Cert:\LocalMachine\My' `
    -NotAfter (Get-Date).AddYears(2) `
    -TextExtension @(
      "2.5.29.17={text}$($sanParts -join '&')",
      '2.5.29.19={critical}{text}ca=0',
      '2.5.29.37={text}1.3.6.1.5.5.7.3.1'
    )

  $passwordBytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
  $pfxPassword = [Convert]::ToBase64String($passwordBytes)
  $enrollmentToken = $existingMetadata.enrollmentToken
  if (-not $enrollmentToken) {
    $enrollmentBytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($enrollmentBytes)
    $enrollmentToken = [Convert]::ToBase64String($enrollmentBytes)
  }
  $securePassword = ConvertTo-SecureString $pfxPassword -AsPlainText -Force
  Export-PfxCertificate -Cert $serverCertificate -FilePath $pfxPath -Password $securePassword -Force | Out-Null
  Export-PemCertificate -Certificate $serverCertificate -Path $certPath

  @{
    hostname = $LanHostname.ToLowerInvariant()
    lanIp = $LanIp
    rootThumbprint = $root.Thumbprint
    serverThumbprint = $serverCertificate.Thumbprint
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    expiresAt = $serverCertificate.NotAfter.ToUniversalTime().ToString('o')
    pfxPassword = $pfxPassword
    enrollmentToken = $enrollmentToken
  } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
} else {
  $pfxPassword = $existingMetadata.pfxPassword
  $enrollmentToken = $existingMetadata.enrollmentToken
  if (-not $enrollmentToken) {
    $enrollmentBytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($enrollmentBytes)
    $enrollmentToken = [Convert]::ToBase64String($enrollmentBytes)
    $existingMetadata | Add-Member -NotePropertyName enrollmentToken -NotePropertyValue $enrollmentToken -Force
    $existingMetadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
  }
}

Set-EnvValue -Name 'HOST' -Value '0.0.0.0'
Set-EnvValue -Name 'HEALTHFLOW_LAN_HOSTNAME' -Value $LanHostname.ToLowerInvariant()
Set-EnvValue -Name 'HEALTHFLOW_LAN_IP' -Value $LanIp
Set-EnvValue -Name 'HEALTHFLOW_TLS_CERT_PATH' -Value $certPath
Set-EnvValue -Name 'HEALTHFLOW_TLS_KEY_PATH' -Value ''
Set-EnvValue -Name 'HEALTHFLOW_TLS_PFX_PATH' -Value $pfxPath
Set-EnvValue -Name 'HEALTHFLOW_TLS_PFX_PASSPHRASE' -Value $pfxPassword
Set-EnvValue -Name 'HEALTHFLOW_WORKSTATION_ENROLLMENT_TOKEN' -Value $enrollmentToken

$acl = Get-Acl $certDir
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $certDir -AclObject $acl

Copy-Item -LiteralPath $rootCerPath -Destination (Join-Path $enrollmentDir 'healthflow-facility-root.cer') -Force
Copy-Item -LiteralPath (Join-Path $serverDir 'scripts\install-workstation-trust.ps1') -Destination $enrollmentDir -Force
$serverUrl = "https://$($LanHostname.ToLowerInvariant()):4780"
Set-Content -LiteralPath (Join-Path $enrollmentDir 'server-url.txt') -Value $serverUrl -Encoding ASCII
Set-Content -LiteralPath (Join-Path $enrollmentDir 'enrollment-token.txt') -Value $enrollmentToken -Encoding ASCII
$bundlePath = Join-Path $InstallRoot 'HealthFlow-Connect-This-Computer.zip'
if (Test-Path -LiteralPath $bundlePath) { Remove-Item -LiteralPath $bundlePath -Force }
Compress-Archive -Path (Join-Path $enrollmentDir '*') -DestinationPath $bundlePath -Force

Write-Host 'HealthFlow facility TLS provisioning completed.'
Write-Host "HTTPS URL:             $serverUrl"
Write-Host "Server certificate:    $certPath"
Write-Host "Workstation installer: $bundlePath"

$service = Get-Service -Name 'HealthFlowOfflineServer' -ErrorAction SilentlyContinue
if ($certificateChanged -and $service) {
  Restart-Service -Name 'HealthFlowOfflineServer' -Force
  Write-Host 'HealthFlow Offline Server restarted with the renewed certificate.'
}
