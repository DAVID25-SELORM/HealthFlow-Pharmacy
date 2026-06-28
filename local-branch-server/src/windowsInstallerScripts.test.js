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

    expect(installer).toContain('Node.js is not installed')
    expect(installer).toContain('OpenJS.NodeJS.LTS')
    expect(installer).toContain('--accept-package-agreements')
    expect(installer).toContain("'nodejs\\node.exe'")
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
