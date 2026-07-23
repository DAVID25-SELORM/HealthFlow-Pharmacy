import { beforeEach, describe, expect, it, vi } from 'vitest'

const { from, invokeTierAccess } = vi.hoisted(() => ({
  from: vi.fn(),
  invokeTierAccess: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: { from },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

import {
  buildOfflineInstallerReleaseFromManifest,
  buildOfflineInstallerReleasePayload,
  enableOfflineInstallerRelease,
  getActiveOfflineInstallerRelease,
  INSTALLER_RELEASE_STATES,
  saveOfflineInstallerRelease,
  requestOfflineInstallerDownload,
  validateOfflineInstallerReleasePayload,
  validateSavedOfflineInstallerRelease,
} from './offlineInstallerReleaseService'

const makeQuery = ({ data = null, error = null } = {}) => {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error })),
    update: vi.fn(() => query),
    upsert: vi.fn(() => query),
    single: vi.fn(async () => ({ data, error })),
  }
  return query
}

describe('offlineInstallerReleaseService', () => {
  beforeEach(() => {
    from.mockReset()
    invokeTierAccess.mockReset()
  })

  it('loads the active runtime installer release', async () => {
    const query = makeQuery({
      data: {
        id: 'release-1',
        version: '1.4.4',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
        file_name: 'HealthFlow-Offline-Installer-1.4.4.zip',
        file_size: 47219500,
        sha256: 'a'.repeat(64),
        release_notes: 'Initial offline installer',
      enabled: true,
      state: 'published',
      validation_status: 'valid',
      published_at: '2026-07-23T00:00:00Z',
      },
    })
    from.mockReturnValue(query)

    await expect(getActiveOfflineInstallerRelease()).resolves.toMatchObject({
      version: '1.4.4',
      downloadUrl: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
      fileName: 'HealthFlow-Offline-Installer-1.4.4.zip',
      enabled: true,
    })
    expect(from).toHaveBeenCalledWith('offline_installer_releases')
    expect(query.eq).toHaveBeenCalledWith('state', 'published')
    expect(query.eq).toHaveBeenCalledWith('enabled', true)
    expect(query.eq).toHaveBeenCalledWith('channel', 'stable')
  })

  it('returns null when runtime release loading fails so env fallback can continue', async () => {
    from.mockReturnValue(makeQuery({ error: { code: '42P01', message: 'missing table' } }))

    await expect(getActiveOfflineInstallerRelease()).resolves.toBeNull()
  })

  it('normalizes release form input for saving', () => {
    expect(
      buildOfflineInstallerReleasePayload({
        version: ' 1.4.4 ',
        downloadUrl: ' https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip ',
        fileName: ' HealthFlow-Offline-Installer-1.4.4.zip ',
        fileSize: '47219500',
        sha256: ` ${'A'.repeat(64)} `,
      enabled: true,
    })
  ).toEqual({
      version: '1.4.4',
      download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
      file_name: 'HealthFlow-Offline-Installer-1.4.4.zip',
      file_size: 47219500,
      sha256: 'a'.repeat(64),
      release_notes: null,
      state: 'draft',
      channel: 'stable',
      validation_status: 'not_validated',
      validation_checked_at: null,
      validation_error: null,
      manifest: {},
      storage_bucket: null,
      storage_path: null,
      built_at: null,
      git_commit: null,
      git_branch: null,
      installer_type: null,
      minimum_supported_app_version: null,
      minimum_supported_local_server_version: null,
      enabled: false,
    })
  })

  it('imports installer release details from a generated manifest', () => {
    const release = buildOfflineInstallerReleaseFromManifest({
      version: '2.1.0',
      file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
      file_size_bytes: 176000000,
      sha256: 'b'.repeat(64),
      built_at: '2026-07-23T10:00:00.000Z',
      git_commit: 'abc123',
      git_branch: 'main',
      installer_type: 'offline-installer',
      minimum_supported_app_version: '1.0.0',
      minimum_supported_local_server_version: '2.1.0',
    })

    expect(release).toMatchObject({
      version: '2.1.0',
      fileName: 'HealthFlow-Offline-Installer-2.1.0.zip',
      fileSize: 176000000,
      sha256: 'b'.repeat(64),
      state: INSTALLER_RELEASE_STATES.UPLOADED,
      validationStatus: 'not_validated',
      gitCommit: 'abc123',
    })
  })

  it('rejects manifest checksum mismatch before saving', () => {
    expect(() => validateOfflineInstallerReleasePayload({
      version: '2.1.0',
      download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
      file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
      file_size: 10,
      sha256: 'a'.repeat(64),
      manifest: {
        version: '2.1.0',
        file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
        file_size_bytes: 10,
        sha256: 'b'.repeat(64),
      },
    })).toThrow('Manifest checksum does not match')
  })

  it('rejects private storage metadata unless bucket and path are supplied together', () => {
    expect(() => validateOfflineInstallerReleasePayload({
      version: '2.1.0',
      download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
      file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
      file_size: 10,
      sha256: 'a'.repeat(64),
      storage_bucket: 'offline-installers',
      storage_path: null,
      manifest: {},
    })).toThrow('Private storage bucket and path must be supplied together')
  })

  it('rejects unsafe URLs before saving a release', async () => {
    await expect(
      saveOfflineInstallerRelease({
        version: '1.4.4',
        downloadUrl: 'http://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
        fileName: 'HealthFlow-Offline-Installer-1.4.4.zip',
        fileSize: 47219500,
        sha256: 'a'.repeat(64),
      })
    ).rejects.toThrow('Installer download URL is invalid')
    expect(from).not.toHaveBeenCalled()
  })

  it('marks a saved release as validated without publishing it', async () => {
    const data = {
      id: 'release-1',
      version: '2.1.0',
      download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
      file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
      file_size: 176000000,
      sha256: 'b'.repeat(64),
      release_notes: null,
      state: 'validated',
      channel: 'stable',
      validation_status: 'valid',
      enabled: false,
    }
    const query = makeQuery({ data })
    from.mockReturnValue(query)

    await expect(saveOfflineInstallerRelease({
      version: '2.1.0',
      downloadUrl: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
      fileName: 'HealthFlow-Offline-Installer-2.1.0.zip',
      fileSize: 176000000,
      sha256: 'b'.repeat(64),
    }, { validate: true })).resolves.toMatchObject({
      version: '2.1.0',
      state: 'validated',
      validationStatus: 'valid',
      enabled: false,
    })
    expect(query.upsert.mock.calls[0][0]).toMatchObject({
      state: 'validated',
      validation_status: 'valid',
      enabled: false,
    })
  })

  it('publishes only a validated release and supersedes the previous stable release', async () => {
    const disableQuery = makeQuery()
    const publishQuery = makeQuery({
      data: {
        id: 'release-2',
        version: '2.1.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
        file_size: 176000000,
        sha256: 'b'.repeat(64),
        release_notes: null,
        state: 'published',
        channel: 'stable',
        validation_status: 'valid',
        enabled: true,
      },
    })
    from.mockReturnValueOnce(disableQuery).mockReturnValueOnce(publishQuery)

    await expect(enableOfflineInstallerRelease('release-2')).resolves.toMatchObject({
      version: '2.1.0',
      state: 'published',
      enabled: true,
    })
    expect(disableQuery.update).toHaveBeenCalledWith({ enabled: false, state: 'superseded' })
    expect(publishQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      state: 'published',
    }))
    expect(publishQuery.eq).toHaveBeenCalledWith('state', 'validated')
    expect(publishQuery.eq).toHaveBeenCalledWith('validation_status', 'valid')
  })

  it('validates a saved release and stores a valid result', async () => {
    const loadQuery = makeQuery({
      data: {
        id: 'release-3',
        version: '2.2.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.2.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.2.0.zip',
        file_size: 180000000,
        sha256: 'c'.repeat(64),
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'not_validated',
        manifest: {
          version: '2.2.0',
          file_name: 'HealthFlow-Offline-Installer-2.2.0.zip',
          file_size_bytes: 180000000,
          sha256: 'c'.repeat(64),
        },
        enabled: false,
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'release-3',
        version: '2.2.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.2.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.2.0.zip',
        file_size: 180000000,
        sha256: 'c'.repeat(64),
        state: 'validated',
        channel: 'stable',
        validation_status: 'valid',
        validation_error: null,
        enabled: false,
      },
    })
    from.mockReturnValueOnce(loadQuery).mockReturnValueOnce(updateQuery)

    await expect(validateSavedOfflineInstallerRelease('release-3')).resolves.toMatchObject({
      state: 'validated',
      validationStatus: 'valid',
    })
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      state: 'validated',
      validation_status: 'valid',
      validation_error: null,
      enabled: false,
    }))
  })

  it('stores an invalid validation result when saved metadata fails validation', async () => {
    const loadQuery = makeQuery({
      data: {
        id: 'release-4',
        version: '2.2.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.2.0.zip',
        file_name: 'HealthFlow-Offline-Installer-wrong.zip',
        file_size: 180000000,
        sha256: 'c'.repeat(64),
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'not_validated',
        manifest: {},
        enabled: false,
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'release-4',
        version: '2.2.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.2.0.zip',
        file_name: 'HealthFlow-Offline-Installer-wrong.zip',
        file_size: 180000000,
        sha256: 'c'.repeat(64),
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'invalid',
        validation_error: 'Installer file name must be HealthFlow-Offline-Installer-2.2.0.zip.',
        enabled: false,
      },
    })
    from.mockReturnValueOnce(loadQuery).mockReturnValueOnce(updateQuery)

    await expect(validateSavedOfflineInstallerRelease('release-4')).resolves.toMatchObject({
      validationStatus: 'invalid',
      validationError: 'Installer file name must be HealthFlow-Offline-Installer-2.2.0.zip.',
    })
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      validation_status: 'invalid',
      validation_error: 'Installer file name must be HealthFlow-Offline-Installer-2.2.0.zip.',
      enabled: false,
    }))
  })

  it('requests a controlled installer download URL through tier-access', async () => {
    invokeTierAccess.mockResolvedValue({
      downloadUrl: 'https://signed.example.test/installer.zip?signature=secret',
      expiresAt: '2026-07-23T10:10:00Z',
      source: 'signed_storage',
      release: {
        version: '2.2.0',
        fileName: 'HealthFlow-Offline-Installer-2.2.0.zip',
        fileSize: 180000000,
        publishedAt: '2026-07-23T10:00:00Z',
        releaseNotes: 'Stable installer',
      },
    })

    await expect(requestOfflineInstallerDownload()).resolves.toMatchObject({
      downloadUrl: 'https://signed.example.test/installer.zip?signature=secret',
      source: 'signed_storage',
      release: {
        version: '2.2.0',
        fileName: 'HealthFlow-Offline-Installer-2.2.0.zip',
      },
    })
    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'request_offline_installer_download',
    })
  })
})
