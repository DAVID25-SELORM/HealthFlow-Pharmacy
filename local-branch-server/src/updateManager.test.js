import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  getManifestSigningPayload,
  getUpdateInstallerCommand,
  verifyUpdateManifest,
} from './updateManager'

describe('branch update security', () => {
  it('compares semantic versions', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.1.9', '1.2.0')).toBe(-1)
    expect(() => compareVersions('latest', '1.2.0')).toThrow(/semantic versioning/i)
  })

  it('accepts a valid Ed25519 manifest signature and rejects tampering', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const manifest = {
      version: '1.1.0',
      channel: 'stable',
      packageUrl: 'https://updates.healthflow.test/healthflow-branch-1.1.0.zip',
      sha256: 'a'.repeat(64),
      publishedAt: '2026-06-12T09:30:00.000Z',
    }
    manifest.signature = crypto
      .sign(null, Buffer.from(getManifestSigningPayload(manifest)), privateKey)
      .toString('base64')

    expect(
      verifyUpdateManifest(
        manifest,
        publicKey.export({ type: 'spki', format: 'pem' }).toString()
      )
    ).toBe(true)

    expect(() =>
      verifyUpdateManifest(
        { ...manifest, packageUrl: 'https://updates.healthflow.test/tampered.zip' },
        publicKey.export({ type: 'spki', format: 'pem' }).toString()
      )
    ).toThrow(/signature is invalid/i)
  })

  it('rejects insecure package URLs', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519')
    expect(() =>
      verifyUpdateManifest(
        {
          version: '1.1.0',
          channel: 'stable',
          packageUrl: 'http://updates.healthflow.test/update.zip',
          sha256: 'a'.repeat(64),
          publishedAt: '2026-06-12T09:30:00.000Z',
          signature: 'invalid',
        },
        publicKey.export({ type: 'spki', format: 'pem' }).toString()
      )
    ).toThrow(/must use HTTPS/i)
  })

  it('builds platform-specific detached installer commands', () => {
    const linux = getUpdateInstallerCommand({
      platform: 'linux',
      pendingPackagePath: '/opt/healthflow/local-branch-server/updates/pending-update.zip',
      expectedVersion: '1.1.0',
    })
    expect(linux).toEqual({
      command: 'sudo',
      args: [
        '-n',
        '/usr/local/lib/healthflow/apply-update-linux.sh',
        '/opt/healthflow/local-branch-server/updates/pending-update.zip',
        '1.1.0',
      ],
      windowsHide: false,
    })

    const windows = getUpdateInstallerCommand({
      platform: 'win32',
      installDir: 'C:\\HealthFlowLocal\\local-branch-server',
      pendingPackagePath: 'C:\\HealthFlowLocal\\local-branch-server\\updates\\pending-update.zip',
      expectedVersion: '1.1.0',
      serviceName: 'HealthFlowOfflineServer',
    })
    expect(windows.command).toBe('powershell.exe')
    expect(windows.args).toContain('HealthFlowOfflineServer')
    expect(windows.windowsHide).toBe(true)

    expect(() =>
      getUpdateInstallerCommand({ platform: 'darwin', expectedVersion: '1.1.0' })
    ).toThrow(/not supported on darwin/i)
  })
})
