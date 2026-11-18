import { describe, expect, it, vi } from 'vitest'
import { parseSetupBlock } from '../../local-branch-server/src/cloudSetupBlock.js'
import {
  buildSetupBlockText,
  buildSetupFile,
  buildSetupFileName,
  hasCloudConnectionValues,
  runOneTapSetup,
  SETUP_FILE_PREFIX,
} from './offlineSetupFile'

// Made-up values in the shape the cloud screen produces. None of these is a real credential.
const result = {
  syncClientId: 'client-1',
  organizationId: '3f2a9c1e-5b7d-4e8a-9c3b-1d2e4f6a8b0c',
  branchId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  branchSyncToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
  nhiaConfigSecretKey: '0f9e8d7c6b5a49382716a5b4c3d2e1f00f9e8d7c6b5a4938',
  activationExpiresAt: '2026-11-20T12:00:00.000Z',
}
const cloud = { cloudUrl: 'https://example-project.supabase.co', syncKey: 'sb_publishable_exampleexampleexample' }

describe('setup block text', () => {
  it('has the same lines the screen has always shown', () => {
    const text = buildSetupBlockText({ result, ...cloud })
    expect(text.split('\n')).toEqual([
      'PORT=4780',
      `NHIA_CONFIG_SECRET_KEY=${result.nhiaConfigSecretKey}`,
      `ORGANIZATION_ID=${result.organizationId}`,
      `BRANCH_ID=${result.branchId}`,
      `BRANCH_SYNC_TOKEN=${result.branchSyncToken}`,
      `SUPABASE_URL=${cloud.cloudUrl}`,
      `SUPABASE_SYNC_KEY=${cloud.syncKey}`,
      'HEALTHFLOW_UPDATE_MANIFEST_URL=<your-signed-update-manifest-url>',
      'HEALTHFLOW_UPDATE_PUBLIC_KEY=<your-update-public-key-with-escaped-newlines>',
      'HEALTHFLOW_UPDATE_AUTO_CHECK_HOURS=24',
      'HEALTHFLOW_UPDATE_AUTO_INSTALL=false',
    ])
  })

  it('is read by the installer exactly as written', () => {
    expect(parseSetupBlock(buildSetupBlockText({ result, ...cloud }))).toEqual({
      organizationId: result.organizationId,
      branchId: result.branchId,
      branchSyncToken: result.branchSyncToken,
      supabaseUrl: cloud.cloudUrl,
      supabaseSyncKey: cloud.syncKey,
      nhiaConfigSecretKey: result.nhiaConfigSecretKey,
    })
  })

  it('is refused by the installer when the cloud address or key is unknown, which is why the button needs them', () => {
    expect(() => parseSetupBlock(buildSetupBlockText({ result }))).toThrow(/placeholder/)
    expect(hasCloudConnectionValues({})).toBe(false)
    expect(hasCloudConnectionValues({ cloudUrl: 'https://x.example', syncKey: '  ' })).toBe(false)
    expect(hasCloudConnectionValues(cloud)).toBe(true)
  })
})

describe('setup file', () => {
  const file = buildSetupFile({ result, machineName: 'Main branch server', now: new Date('2026-11-18T10:00:00Z'), ...cloud })

  it('is named so the installer can find it', () => {
    expect(file.fileName).toBe('HealthFlow-Setup-Main-branch-server.txt')
    expect(file.fileName.startsWith(SETUP_FILE_PREFIX)).toBe(true)
    expect(file.fileName.endsWith('.txt')).toBe(true)
  })

  it('is read by the installer with its header and Windows line endings', () => {
    expect(file.content).toContain('\r\n')
    expect(parseSetupBlock(file.content).branchSyncToken).toBe(result.branchSyncToken)
    expect(parseSetupBlock(file.content).organizationId).toBe(result.organizationId)
  })

  it('records when it expires, in the form the installer reads, and never repeats a secret in the header', () => {
    expect(file.content).toContain('# HEALTHFLOW_SETUP_EXPIRES=2026-11-20T12:00:00.000Z')
    const header = file.content.split('\r\n').filter((line) => line.startsWith('#')).join('\n')
    for (const secret of [result.branchSyncToken, result.nhiaConfigSecretKey, cloud.syncKey]) {
      expect(header).not.toContain(secret)
    }
  })

  it('leaves out the expiry marker when the cloud gave none', () => {
    const noExpiry = buildSetupFile({ result: { ...result, activationExpiresAt: null }, ...cloud })
    expect(noExpiry.content).not.toContain('HEALTHFLOW_SETUP_EXPIRES')
    expect(parseSetupBlock(noExpiry.content).branchId).toBe(result.branchId)
  })

  it('cannot put a path or odd characters into the file name', () => {
    for (const name of ['..\\..\\evil', '../etc/passwd', 'Pharmacie Générale', 'a'.repeat(200), '', '   ', '###']) {
      const fileName = buildSetupFileName(name)
      expect(fileName).toMatch(/^HealthFlow-Setup-[A-Za-z0-9-]{1,40}\.txt$/)
    }
    expect(buildSetupFileName('Pharmacie Générale')).toBe('HealthFlow-Setup-Pharmacie-Generale.txt')
    expect(buildSetupFileName('')).toBe('HealthFlow-Setup-computer.txt')
  })

  it('keeps a machine name with line breaks from adding lines to the header', () => {
    const tricky = buildSetupFile({ result, machineName: 'Shop\r\nBRANCH_ID=evil', ...cloud })
    expect(parseSetupBlock(tricky.content).branchId).toBe(result.branchId)
  })
})

describe('one-tap order of steps', () => {
  const steps = () => {
    const calls = []
    return {
      calls,
      deps: {
        prepareInstaller: vi.fn(async () => {
          calls.push('prepare')
          return 'https://downloads.example/installer.zip'
        }),
        register: vi.fn(async () => {
          calls.push('register')
          return result
        }),
        buildFile: vi.fn((registered) => {
          calls.push('build')
          return { fileName: 'HealthFlow-Setup-x.txt', content: registered.branchSyncToken }
        }),
        saveSetupFile: vi.fn(() => calls.push('save-file')),
        startInstallerDownload: vi.fn(() => calls.push('download-installer')),
      },
    }
  }

  it('prepares the installer, registers, then downloads the setup file and the installer', async () => {
    const { calls, deps } = steps()
    const outcome = await runOneTapSetup(deps)
    expect(calls).toEqual(['prepare', 'register', 'build', 'save-file', 'download-installer'])
    expect(outcome).toMatchObject({ started: true, fileName: 'HealthFlow-Setup-x.txt' })
    expect(deps.startInstallerDownload).toHaveBeenCalledWith('https://downloads.example/installer.zip')
  })

  it('registers nothing when the installer cannot be downloaded', async () => {
    const { deps } = steps()
    deps.prepareInstaller.mockResolvedValue('')
    const outcome = await runOneTapSetup(deps)
    expect(outcome).toEqual({ started: false, reason: 'installer-unavailable' })
    expect(deps.register).not.toHaveBeenCalled()
    expect(deps.saveSetupFile).not.toHaveBeenCalled()
  })

  it('downloads nothing when registration fails', async () => {
    const { deps } = steps()
    deps.register.mockResolvedValue(null)
    const outcome = await runOneTapSetup(deps)
    expect(outcome).toEqual({ started: false, reason: 'registration-failed' })
    expect(deps.saveSetupFile).not.toHaveBeenCalled()
    expect(deps.startInstallerDownload).not.toHaveBeenCalled()
  })

  it('lets an unexpected error from registration reach the caller', async () => {
    const { deps } = steps()
    deps.register.mockRejectedValue(new Error('network down'))
    await expect(runOneTapSetup(deps)).rejects.toThrow('network down')
    expect(deps.saveSetupFile).not.toHaveBeenCalled()
  })
})
