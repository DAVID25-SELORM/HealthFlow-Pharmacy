import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readScript = (name) =>
  fs.readFileSync(path.join(serverDir, 'scripts', name), 'utf8')

describe('Windows production installer scripts', () => {
  it('validates production configuration, runtime, and post-install health', () => {
    const installer = readScript('install-service.ps1')

    expect(installer).toContain("InstallRoot = 'C:\\HealthFlowLocal'")
    expect(installer).toContain('Assert-ProductionConfiguration')
    expect(installer).toContain('Assert-NodeVersion')
    expect(installer).toContain('HealthFlow requires Node.js 20 or newer')
    expect(installer).toContain('production health checks did not pass')
    expect(installer).toContain('provision-facility-tls.ps1')
    expect(installer).toContain('HealthFlow TLS Certificate Renewal')
    expect(installer).toContain('New-NetFirewallRule')
  })

  it('does not pass an empty -LanIp to the TLS provisioner', () => {
    // Windows PowerShell 5.1 drops an empty string argument, which left "-LanIp" with no value and
    // stopped the first install with "Missing an argument for parameter 'LanIp'".
    const installer = readScript('install-service.ps1').replace(/\r\n/g, '\n')

    expect(installer).toContain('$tlsArguments')
    expect(installer).toContain("if ($LanIp) {\n  $tlsArguments += @('-LanIp', $LanIp)\n}")
    expect(installer).not.toMatch(/-LanHostname \$LanHostname `\n\s*-LanIp \$LanIp/)
    expect(installer).toContain("if ($LanIp) {\n  $renewalArgument += ")
    expect(installer).not.toContain('-LanHostname `"$LanHostname`" -LanIp')
  })

  it('uses only random-number code that exists in Windows PowerShell 5.1', () => {
    // RandomNumberGenerator.Fill is .NET Core only, so it stopped the install on a real computer with
    // "does not contain a method named 'Fill'". Create().GetBytes works on every PowerShell.
    const scriptsDir = path.join(serverDir, 'scripts')
    const offenders = fs
      .readdirSync(scriptsDir)
      .filter((name) => name.endsWith('.ps1'))
      .filter((name) => readScript(name).includes('RandomNumberGenerator]::Fill('))

    expect(offenders).toEqual([])
    expect(readScript('provision-facility-tls.ps1')).toContain('RandomNumberGenerator]::Create()')
    expect(readScript('install-service.ps1')).toContain('RandomNumberGenerator]::Create()')
  })

  it('replaces every placeholder the settings template ships, including change-this', () => {
    // The template ships BRANCH_SERVER_TOKEN=change-this-long-random-local-token. The installer
    // only swapped "change-me"-style placeholders, so the server refused to start (service Paused)
    // with "Set BRANCH_SERVER_TOKEN to a long random value before starting the server.".
    const installer = readScript('install-service.ps1').replace(/\r\n/g, '\n')
    const pattern = installer.match(/\$branchToken -match '([^']+)'/)?.[1]
    expect(pattern).toBeTruthy()
    const isPlaceholder = new RegExp(pattern, 'i')

    const template = fs
      .readFileSync(path.join(serverDir, '.env.example'), 'utf8')
      .replace(/\r\n/g, '\n')
    const valueOf = (name) => template.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? ''
    for (const name of ['BRANCH_SERVER_TOKEN', 'BRANCH_SYNC_TOKEN']) {
      expect(valueOf(name), name).not.toBe('')
      expect(isPlaceholder.test(valueOf(name)), `${name} placeholder is replaced`).toBe(true)
    }

    // The same pattern is used for the cloud values, so the three copies must agree.
    expect(installer.match(/-match 'change\[-_ \]\?\(me\|this\)\|placeholder\|your\[-_ \]'/g)).toHaveLength(3)
  })

  it('opens the secure port with the whole certificate setting, so a PFX install has a certificate', () => {
    // The installer provisions server.pfx. The server used to pass only cert and key, which are empty for a
    // PFX, so every secure connection failed and the first health check could never pass.
    const server = fs.readFileSync(path.join(serverDir, 'src', 'server.js'), 'utf8')

    expect(server).toContain('https.createServer(tlsRuntime.credentials, app)')
    expect(server).not.toContain('key: tlsRuntime.credentials.key')
  })

  it('can be run again over a working install without failing on the running service', () => {
    // The Windows service is the installed copy of nssm.exe, so Windows will not let it be overwritten while it
    // runs. Any failure was reported as "NSSM is not bundled", which was wrong (the file was in the zip).
    const installer = readScript('install-service.ps1').replace(/\r\n/g, '\n')

    expect(installer).toContain('Get-FileHash -LiteralPath $resolved -Algorithm SHA256')
    expect(installer).toContain("Stop-Service -Name 'HealthFlowOfflineServer' -Force")
    expect(installer).toContain('NSSM could not be prepared: $($_.Exception.Message)')
    expect(installer).not.toContain('NSSM is not bundled with this installer.')
  })

  it('keeps an earlier workstation enrollment when the installer is run again', () => {
    // An enrollment token works once. The first install used it, so running the installer again got
    // "Workstation enrollment token is invalid." at the very last step and the install "did not finish".
    const trust = readScript('install-workstation-trust.ps1').replace(/\r\n/g, '\n')

    expect(trust).toContain('function Get-WorkstationEnrollment {')
    expect(trust).toContain('[int]$_.Exception.Response.StatusCode')
    expect(trust).toContain('$statusCode -eq 401 -and $hasDevice')
    expect(trust).toContain('already enrolled with this branch server')
    // The earlier enrollment is read before the enrollment request, and still written only once.
    expect(trust.indexOf('$existingDevice = $null')).toBeLessThan(trust.indexOf('Get-WorkstationEnrollment -ServerUrl'))
  })

  it('stops the old server before copying files over a working install', () => {
    // The running server holds node.exe, the SQLite native module and nssm.exe open, so copying the server
    // folder over it failed with "The process cannot access the file ... because it is being used by another
    // process" and the install "did not finish". The old server is now stopped first.
    const installer = readScript('install-service.ps1').replace(/\r\n/g, '\n')

    expect(installer).toContain('function Stop-ExistingServer {')
    expect(installer).toContain("Stop-Service -Name 'HealthFlowOfflineServer' -Force")
    expect(installer).toContain('StartsWith($installPrefix')
    // It runs before any file is copied into the install folder.
    expect(installer.indexOf('\nStop-ExistingServer\n')).toBeGreaterThan(0)
    expect(installer.indexOf('\nStop-ExistingServer\n')).toBeLessThan(installer.indexOf('\nCopy-BranchServer\n'))
  })

  it('checks the server at its real address after connecting to the cloud, and waits for it to start', () => {
    // After the cloud connection is saved the service restarts. The check ran at once against
    // http://localhost:4780, but a server with a certificate only speaks HTTPS, so it failed with
    // "The connection was closed unexpectedly" and the setup reported that it "did not finish".
    const health = readScript('health-check.ps1').replace(/\r\n/g, '\n')
    const connect = readScript('connect-to-cloud.ps1').replace(/\r\n/g, '\n')

    expect(health).toContain("[string]$BaseUrl = ''")
    expect(health).not.toContain("[string]$BaseUrl = 'http://localhost:4780'")
    expect(health).toContain('$BaseUrl = if ($tlsConfigured) { "https://${lanHostname}:$port" } else { "http://localhost:$port" }')
    expect(connect).toContain('for ($attempt = 1; $attempt -le 20; $attempt += 1)')
    expect(connect).toContain('& powershell -NoProfile -ExecutionPolicy Bypass -File $healthScript')
  })

  it('provisions a facility CA and creates a workstation enrollment bundle', () => {
    const provisioner = readScript('provision-facility-tls.ps1')
    const workstation = readScript('install-workstation-trust.ps1')

    expect(provisioner).toContain('New-SelfSignedCertificate')
    expect(provisioner).toContain('HealthFlow Facility Root')
    expect(provisioner).toContain('Export-PfxCertificate')
    expect(provisioner).toContain('HealthFlow-Connect-This-Computer.zip')
    expect(provisioner).toContain('SetAccessRuleProtection')
    expect(workstation).toContain("Cert:\\LocalMachine\\Root")
    expect(workstation).toContain('HealthFlow Offline POS.url')
  })

  it('automatically installs the Node.js LTS runtime when it is missing', () => {
    const installer = readScript('install-windows-service.ps1')

    expect(installer).toContain("runtime\\node\\node.exe")
    expect(installer).toContain('Node.js is not installed')
    expect(installer).toContain('OpenJS.NodeJS.LTS')
    expect(installer).toContain('--accept-package-agreements')
    expect(installer).toContain("'nodejs\\node.exe'")
  })

  it('supports a complete offline first-time installer package', () => {
    const elevatedInstaller = readScript('install-windows-service.ps1')
    const serviceInstaller = readScript('install-service.ps1')
    const launcher = readScript('../Install-HealthFlow.cmd')
    const packageBuilder = readScript('build-offline-installer-package.ps1')

    expect(launcher).toContain('-OfflineOnly')
    expect(launcher).not.toContain('-InstallDependencies')
    expect(elevatedInstaller).toContain('[switch]$OfflineOnly')
    expect(elevatedInstaller).toContain('Node.js runtime is not bundled')
    expect(elevatedInstaller).toContain('$arguments += \'-OfflineOnly\'')

    expect(serviceInstaller).toContain('[switch]$OfflineOnly')
    expect(serviceInstaller).toContain('NSSM could not be prepared')
    expect(serviceInstaller).toContain("throw 'Production dependencies are not bundled")
    expect(serviceInstaller).toContain("$excluded = @('data', 'logs', '.env')")
    expect(serviceInstaller).toContain('node_modules already exists. Skipping npm install.')

    expect(packageBuilder).toContain('npm.cmd run build:offline')
    expect(packageBuilder).toContain('latest-v22.x')
    expect(packageBuilder).toContain('runtime\\node')
    expect(packageBuilder).toContain("$nodeExe = Join-Path $runtimeDir 'node.exe'")
    expect(packageBuilder).toContain("$npmCliPath = Join-Path $runtimeDir 'node_modules\\npm\\bin\\npm-cli.js'")
    expect(packageBuilder).toContain('& $nodeExe $npmCliPath ci --omit=dev')
    expect(packageBuilder).toContain('HealthFlow-Offline-Installer-')
    expect(packageBuilder).toContain('VITE_HEALTHFLOW_INSTALLER_URL=')
  })

  describe('post-install launch of the app on a fresh install only', () => {
    const installer = readScript('install-windows-service.ps1')

    it('derives fresh-install state from the pre-existing service registration, not the database', () => {
      // Checked via Get-Service, before any installation step runs — an
      // installation-state signal, not a data-state one.
      expect(installer).toContain(
        "$serviceExistedBeforeInstall = [bool](Get-Service -Name $healthFlowServiceName -ErrorAction SilentlyContinue)"
      )
      expect(installer).toContain('$isFreshInstall = -not $serviceExistedBeforeInstall')

      // The database file must play no part in this decision, in either
      // direction — an existing install with a missing/quarantined/relocated
      // DB must not look "fresh", and a fresh install seeded with a
      // pre-existing DB file must not look "not fresh".
      expect(installer).not.toContain('$isFreshInstall = -not (Test-Path -LiteralPath $targetDbPath)')
      expect(installer).not.toMatch(/\$isFreshInstall\s*=[\s\S]{0,80}\$targetDbPath/)
    })

    it('checks the service is actually Running immediately before launching, not just before install', () => {
      // A second, later check — the service could stop between the top of
      // the script and this point (e.g. a crash right after start).
      expect(installer).toMatch(
        /if\s*\(\$isFreshInstall\)\s*\{[\s\S]*Get-Service -Name \$healthFlowServiceName[\s\S]*Status -ne 'Running'/
      )
      expect(installer).toContain('Skipping automatic launch.')
    })

    it('polls the existing /health endpoint with a bounded timeout and short retry interval, reusing it rather than adding a new one', () => {
      expect(installer).toContain('function Wait-HealthFlowServerReachable')
      expect(installer).toContain('-Url "$serverUrl/health"')
      expect(installer).toContain('-TimeoutSeconds 30')
      expect(installer).toContain('-IntervalSeconds 2')
      expect(installer).toMatch(/Invoke-WebRequest -Uri \$Url -UseBasicParsing -TimeoutSec 5/)
    })

    it('never reads, sends, or logs the branch token while checking reachability', () => {
      const fn = installer.slice(
        installer.indexOf('function Wait-HealthFlowServerReachable'),
        installer.indexOf('if ($isFreshInstall) {')
      )
      expect(fn).not.toMatch(/BRANCH_SERVER_TOKEN|BranchToken|x-branch-token|headers/i)
    })

    it('launches exactly once, only after reachability succeeds', () => {
      expect(installer).toMatch(
        /if\s*\(\$reachable\)\s*\{[\s\S]*Start-Process \$serverUrl[\s\S]*\}\s*else\s*\{/
      )
      expect((installer.match(/Start-Process \$serverUrl/g) || []).length).toBe(1)
      expect(installer).not.toMatch(/Start-Process \$serverUrl\?/)
      expect(installer).not.toMatch(/Start-Process .*(BRANCH_SERVER_TOKEN|BranchToken)/)
    })

    it('does not launch and prints a manual instruction when the server never becomes reachable', () => {
      expect(installer).toContain('did not become reachable within 30 seconds')
      expect(installer).toContain('It may still be starting.')
      expect(installer).toMatch(
        /did not become reachable within 30 seconds[\s\S]{0,40}\n[\s\S]*?desktop shortcut, once it finishes starting\./
      )
    })

    it('does not fail the install and still prints a manual instruction if the browser launch itself throws', () => {
      expect(installer).toMatch(/try\s*\{[\s\S]*Start-Process \$serverUrl[\s\S]*\}\s*catch\s*\{/)
      expect(installer).toContain('Could not open the browser automatically.')
      expect(installer).toContain("desktop shortcut, to continue setup.")
    })

    it('reuses the existing server URL construction with no token or query string appended anywhere in the block', () => {
      expect(installer).toContain('$serverUrl = "https://$($LanHostname.ToLowerInvariant()):4780"')
      const launchBlock = installer.slice(installer.indexOf('function Wait-HealthFlowServerReachable'))
      expect(launchBlock).not.toMatch(/serverUrl\??[=&]\w*token/i)
      expect(launchBlock).not.toMatch(/BRANCH_SERVER_TOKEN|BRANCH_SYNC_TOKEN/)
    })
  })

  it('backs up the database and verifies API health before completing an update', () => {
    const updater = readScript('apply-update.ps1')

    expect(updater).toContain("[string]$DatabasePath")
    expect(updater).toContain("State 'backing_up'")
    expect(updater).toContain("State 'verifying'")
    expect(updater).toContain('Wait-HealthFlowReady')
    expect(updater).toContain("@('', '-wal', '-shm')")
    expect(updater).toContain('Restore-Backup')
  })
})
