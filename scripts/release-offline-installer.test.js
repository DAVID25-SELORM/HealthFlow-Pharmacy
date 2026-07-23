import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INSTALLER_PREFIX,
  InstallerReleaseError,
  calculateSha256,
  ensureVersionedInstallerName,
  findInstallerZip,
  redactEnvSnapshot,
  releaseOfflineInstaller,
  validateInstallerUrl,
  writeInstallerManifest,
} from './release-offline-installer.mjs'

const createRepo = async (version = '1.4.4') => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'healthflow-installer-release-'))
  await fs.mkdir(path.join(repoRoot, 'local-branch-server'), { recursive: true })
  await fs.mkdir(path.join(repoRoot, 'release', 'installers'), { recursive: true })
  await fs.writeFile(
    path.join(repoRoot, 'local-branch-server', 'package.json'),
    JSON.stringify({ version }),
    'utf8'
  )
  return repoRoot
}

describe('offline installer release helper', () => {
  it('generates a SHA-256 checksum for the installer ZIP', async () => {
    const repoRoot = await createRepo()
    const zipPath = path.join(repoRoot, 'release', 'installers', 'example.zip')
    await fs.writeFile(zipPath, 'offline installer bytes', 'utf8')

    await expect(calculateSha256(zipPath)).resolves.toBe(
      'a917727f1d6189caa532740840b717161c3203d928587247bd443c08235c8c59'
    )
  })

  it('rejects missing installer ZIP output', async () => {
    const repoRoot = await createRepo('2.0.0')

    await expect(
      findInstallerZip(path.join(repoRoot, 'release', 'installers'), '2.0.0')
    ).rejects.toMatchObject({ code: 'ZIP_NOT_FOUND' })
  })

  it('rejects duplicate ZIPs for the same version', async () => {
    const repoRoot = await createRepo('2.0.0')
    const installersDir = path.join(repoRoot, 'release', 'installers')
    await fs.writeFile(path.join(installersDir, `${INSTALLER_PREFIX}-2.0.0-windows.zip`), 'one')
    await fs.writeFile(path.join(installersDir, `${INSTALLER_PREFIX}-2.0.0-full.zip`), 'two')

    await expect(findInstallerZip(installersDir, '2.0.0')).rejects.toMatchObject({
      code: 'DUPLICATE_INSTALLER_VERSION',
    })
  })

  it('renames a matching version ZIP to the canonical filename', async () => {
    const repoRoot = await createRepo('2.0.0')
    const installersDir = path.join(repoRoot, 'release', 'installers')
    const source = path.join(installersDir, `${INSTALLER_PREFIX}-2.0.0-full.zip`)
    await fs.writeFile(source, 'zip')

    const renamed = await ensureVersionedInstallerName(source, installersDir, '2.0.0')

    expect(path.basename(renamed)).toBe(`${INSTALLER_PREFIX}-2.0.0.zip`)
    await expect(fs.readFile(renamed, 'utf8')).resolves.toBe('zip')
  })

  it('rejects a rename when the canonical version already exists', async () => {
    const repoRoot = await createRepo('2.0.0')
    const installersDir = path.join(repoRoot, 'release', 'installers')
    const source = path.join(installersDir, `${INSTALLER_PREFIX}-2.0.0-full.zip`)
    await fs.writeFile(source, 'zip')
    await fs.writeFile(path.join(installersDir, `${INSTALLER_PREFIX}-2.0.0.zip`), 'existing')

    await expect(ensureVersionedInstallerName(source, installersDir, '2.0.0')).rejects.toMatchObject({
      code: 'DUPLICATE_INSTALLER_VERSION',
    })
  })

  it('rejects insecure, local, placeholder, and non-installer URLs', () => {
    const invalidUrls = [
      'http://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip',
      'file:///C:/HealthFlow-Offline-Installer-2.0.0.zip',
      'javascript:alert(1)',
      'https://localhost/HealthFlow-Offline-Installer-2.0.0.zip',
      'https://example.com/HealthFlow-Offline-Installer-2.0.0.zip',
      'https://downloads.healthflowcloud.com/not-the-installer.zip',
      'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.exe',
    ]

    for (const url of invalidUrls) {
      expect(() => validateInstallerUrl(url)).toThrow(InstallerReleaseError)
    }
  })

  it('accepts a versioned HTTPS installer URL', () => {
    expect(
      validateInstallerUrl('https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip')
    ).toBe('https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip')
  })

  it('summarizes a successful release without running upload logic', async () => {
    const repoRoot = await createRepo('2.0.0')
    const installersDir = path.join(repoRoot, 'release', 'installers')
    const zipPath = path.join(installersDir, `${INSTALLER_PREFIX}-2.0.0.zip`)

    const result = await releaseOfflineInstaller({
      repoRoot,
      installerUrl: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip',
      checkRemoteUrl: false,
      buildRunner: async () => {
        await fs.writeFile(zipPath, 'zip')
      },
    })

    expect(result).toMatchObject({
      version: '2.0.0',
      fileName: `${INSTALLER_PREFIX}-2.0.0.zip`,
      fileSizeBytes: 3,
      installerUrl: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip',
      upload: { automated: false },
    })
    expect(result.sha256).toBe('4a70fe9aa6436e02c2dea340fbd1e352e4ef2d8ce6ca52ad25d4b95471fc8bf2')
    expect(path.basename(result.manifestPath)).toBe(`${INSTALLER_PREFIX}-2.0.0.manifest.json`)
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))
    expect(manifest).toMatchObject({
      version: '2.0.0',
      file_name: `${INSTALLER_PREFIX}-2.0.0.zip`,
      file_size_bytes: 3,
      sha256: '4a70fe9aa6436e02c2dea340fbd1e352e4ef2d8ce6ca52ad25d4b95471fc8bf2',
      installer_type: 'offline-installer',
    })
    expect(JSON.stringify(manifest)).not.toContain(repoRoot)
  })

  it('writes a machine-readable manifest without local absolute paths', async () => {
    const repoRoot = await createRepo('2.1.0')
    await fs.writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const zipPath = path.join(repoRoot, 'release', 'installers', `${INSTALLER_PREFIX}-2.1.0.zip`)
    await fs.writeFile(zipPath, 'zip')

    const { manifest, manifestPath } = await writeInstallerManifest({
      repoRoot,
      zipPath,
      version: '2.1.0',
      fileName: `${INSTALLER_PREFIX}-2.1.0.zip`,
      fileSizeBytes: 3,
      sha256: 'b'.repeat(64),
      gitMetadata: { git_commit: 'abc123', git_branch: 'main' },
    })

    expect(path.basename(manifestPath)).toBe(`${INSTALLER_PREFIX}-2.1.0.manifest.json`)
    expect(manifest).toMatchObject({
      version: '2.1.0',
      file_name: `${INSTALLER_PREFIX}-2.1.0.zip`,
      file_size_bytes: 3,
      sha256: 'b'.repeat(64),
      git_commit: 'abc123',
      git_branch: 'main',
      installer_type: 'offline-installer',
      minimum_supported_app_version: '1.0.0',
      minimum_supported_local_server_version: '2.1.0',
    })
    expect(JSON.stringify(manifest)).not.toContain(repoRoot)
  })

  it('reports build command failure before looking for ZIP output', async () => {
    const repoRoot = await createRepo('2.0.0')

    await expect(
      releaseOfflineInstaller({
        repoRoot,
        buildRunner: async () => {
          throw new InstallerReleaseError('BUILD_COMMAND_FAILED', 'build failed')
        },
      })
    ).rejects.toMatchObject({ code: 'BUILD_COMMAND_FAILED' })
  })

  it('redacts sensitive environment values from any diagnostic snapshot', () => {
    expect(
      redactEnvSnapshot({
        HEALTHFLOW_INSTALLER_URL:
          'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip',
        SUPABASE_SERVICE_ROLE_KEY: 'should-not-print',
        BRANCH_SYNC_TOKEN: 'also-secret',
      })
    ).toEqual({
      HEALTHFLOW_INSTALLER_URL:
        'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip',
      SUPABASE_SERVICE_ROLE_KEY: '[redacted]',
      BRANCH_SYNC_TOKEN: '[redacted]',
    })
  })
})
