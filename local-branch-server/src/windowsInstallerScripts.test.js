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
    expect(serviceInstaller).toContain("throw 'NSSM is not bundled with this installer")
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
