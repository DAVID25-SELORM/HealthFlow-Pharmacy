import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  from,
  storageFrom,
  upload,
  download,
  insert,
  getUser,
  invokeTierAccess,
  tusStart,
  tusState,
  TusUpload,
} = vi.hoisted(() => {
  const tusState = { file: null, options: null }
  const tusStart = vi.fn()
  const TusUpload = vi.fn(function TusUploadMock(file, options) {
    tusState.file = file
    tusState.options = options
    return { start: tusStart }
  })
  return {
  from: vi.fn(),
  storageFrom: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  insert: vi.fn(),
  getUser: vi.fn(),
  invokeTierAccess: vi.fn(),
    tusStart,
    tusState,
    TusUpload,
  }
})

vi.mock('../lib/supabase', () => ({
  supabase: {
    from,
    storage: {
      from: storageFrom,
    },
    auth: {
      getUser,
    },
  },
  getCachedSupabaseSession: () => ({ access_token: 'access-token-1' }),
  getConfiguredSupabaseStorageUrl: () => 'https://project-ref.storage.supabase.co',
  getConfiguredSupabaseKey: () => 'anon-key-1',
}))

vi.mock('tus-js-client', () => ({
  Upload: TusUpload,
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

import {
  approveOfflineInstallerRelease,
  buildOfflineInstallerReleaseFromManifest,
  buildOfflineInstallerReleaseFromZipFile,
  buildOfflineInstallerReleasePayload,
  calculateOfflineInstallerSha256,
  enableOfflineInstallerRelease,
  extractOfflineInstallerVersionFromFileName,
  findArchiveBombEntries,
  findUnsafeZipEntryPaths,
  getActiveOfflineInstallerRelease,
  INSTALLER_RELEASE_STATES,
  listOfflineInstallerReleases,
  rollbackOfflineInstallerRelease,
  saveOfflineInstallerRelease,
  requestOfflineInstallerDownload,
  uploadOfflineInstallerReleaseZip,
  validateOfflineInstallerArchive,
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
    insert: vi.fn(() => query),
    upsert: vi.fn(() => query),
    single: vi.fn(async () => ({ data, error })),
    then: vi.fn((resolve, reject) => Promise.resolve({ data, error }).then(resolve, reject)),
  }
  return query
}

const concatUint8Arrays = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const makeTestZip = (entryNames) => {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const name of entryNames) {
    const nameBytes = encoder.encode(name)
    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, localOffset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)
    localOffset += local.length
  }

  const centralDirectory = concatUint8Arrays(centralParts)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entryNames.length, true)
  endView.setUint16(10, entryNames.length, true)
  endView.setUint32(12, centralDirectory.length, true)
  endView.setUint32(16, localOffset, true)
  return concatUint8Arrays([...localParts, centralDirectory, end])
}

const makeTestZipWithSizes = (entries) => {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint32(20, entry.compressedSize || 0, true)
    centralView.setUint32(24, entry.uncompressedSize || 0, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, localOffset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)
    localOffset += local.length
  }

  const centralDirectory = concatUint8Arrays(centralParts)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralDirectory.length, true)
  endView.setUint32(16, localOffset, true)
  return concatUint8Arrays([...localParts, centralDirectory, end])
}

const REQUIRED_ZIP_ENTRIES = [
  'local-branch-server/Install-HealthFlow.cmd',
  'local-branch-server/package.json',
  'local-branch-server/public/index.html',
  'local-branch-server/scripts/install-windows-service.ps1',
  'local-branch-server/scripts/start-healthflow-offline.cmd',
  'local-branch-server/src/schema.sql',
  'local-branch-server/src/server.js',
]

const makeInstallerFile = (entries = REQUIRED_ZIP_ENTRIES) => {
  const bytes = makeTestZip(entries)
  return new File([bytes], 'HealthFlow-Offline-Installer-2.5.0.zip', { type: 'application/zip' })
}

describe('offlineInstallerReleaseService', () => {
  beforeEach(() => {
    from.mockReset()
    storageFrom.mockReset()
    upload.mockReset()
    download.mockReset()
    insert.mockReset()
    getUser.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    invokeTierAccess.mockReset()
    tusStart.mockReset()
    TusUpload.mockClear()
    tusState.file = null
    tusState.options = null
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
    expect(query.eq).toHaveBeenCalledWith('enabled', true)
    expect(query.eq).not.toHaveBeenCalledWith('state', 'published')
    expect(query.eq).not.toHaveBeenCalledWith('channel', 'stable')
    expect(query.select).toHaveBeenCalledWith(expect.not.stringContaining('state'))
  })

  it('returns null when runtime release loading fails so env fallback can continue', async () => {
    from.mockReturnValue(makeQuery({ error: { code: '42P01', message: 'missing table' } }))

    await expect(getActiveOfflineInstallerRelease()).resolves.toBeNull()
  })

  it('uses schema-compatible fields for runtime reads before lifecycle columns are migrated', async () => {
    const query = makeQuery({
      data: {
        id: 'release-legacy',
        version: '1.4.4',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
        file_name: 'HealthFlow-Offline-Installer-1.4.4.zip',
        file_size: 47219500,
        sha256: 'a'.repeat(64),
        release_notes: 'Legacy release row',
        enabled: true,
        published_at: '2026-07-23T00:00:00Z',
      },
    })
    from.mockReturnValue(query)

    await expect(getActiveOfflineInstallerRelease()).resolves.toMatchObject({
      id: 'release-legacy',
      state: 'published',
      enabled: true,
      version: '1.4.4',
    })
    expect(query.eq).toHaveBeenCalledWith('enabled', true)
    expect(query.eq).not.toHaveBeenCalledWith('state', 'published')
    expect(query.select).toHaveBeenCalledWith(expect.not.stringContaining('state'))
  })

  it('lists release rows using schema-compatible fields before lifecycle columns are migrated', async () => {
    const query = makeQuery({
      data: [{
        id: 'release-legacy',
        version: '1.4.4',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
        file_name: 'HealthFlow-Offline-Installer-1.4.4.zip',
        file_size: 47219500,
        sha256: 'a'.repeat(64),
        enabled: true,
        published_at: '2026-07-23T00:00:00Z',
      }],
    })
    from.mockReturnValue(query)

    const fullQuery = makeQuery({ error: { code: '42703', message: 'column state does not exist' } })
    const legacyQuery = query
    from.mockReset()
    from.mockReturnValueOnce(fullQuery).mockReturnValueOnce(legacyQuery)

    await expect(listOfflineInstallerReleases()).resolves.toHaveLength(1)
    expect(fullQuery.select).toHaveBeenCalledWith(expect.stringContaining('state'))
    expect(legacyQuery.select).toHaveBeenCalledWith(expect.not.stringContaining('state'))
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
      validation_report: [],
      validation_critical_count: 0,
      validation_warning_count: 0,
      validation_info_count: 0,
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

  it('extracts the installer version from the approved ZIP filename', () => {
    expect(extractOfflineInstallerVersionFromFileName('HealthFlow-Offline-Installer-2.1.0.zip')).toBe('2.1.0')
    expect(() => extractOfflineInstallerVersionFromFileName('HealthFlow.zip')).toThrow(
      'Installer ZIP must be named'
    )
  })

  it('calculates SHA-256 for an installer ZIP file', async () => {
    const file = new File(['healthflow-offline'], 'HealthFlow-Offline-Installer-2.1.0.zip', {
      type: 'application/zip',
    })

    await expect(calculateOfflineInstallerSha256(file)).resolves.toBe(
      '670544af616b9f4359c4547cd24fc78abcad03193ec98735c07564e1f1069c4e'
    )
  })

  it('builds private-storage release metadata from an uploaded ZIP', async () => {
    const file = new File(['healthflow-offline'], 'HealthFlow-Offline-Installer-2.1.0.zip', {
      type: 'application/zip',
    })

    await expect(buildOfflineInstallerReleaseFromZipFile(file, {
      releaseNotes: 'Private pilot',
    })).resolves.toMatchObject({
      version: '2.1.0',
      downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.1.0.zip',
      fileName: 'HealthFlow-Offline-Installer-2.1.0.zip',
      fileSize: file.size,
      releaseNotes: 'Private pilot',
      state: INSTALLER_RELEASE_STATES.UPLOADED,
      storageBucket: 'healthflow-offline-installers',
      storagePath: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
      manifest: expect.objectContaining({
        storage_bucket: 'healthflow-offline-installers',
        storage_path: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
      }),
    })
  })

  it('uploads installer ZIPs to the private release bucket without overwriting existing files', async () => {
    const file = new File(['healthflow-offline'], 'HealthFlow-Offline-Installer-2.1.0.zip', {
      type: 'application/zip',
    })
    upload.mockResolvedValue({ data: { path: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip' }, error: null })
    storageFrom.mockReturnValue({ upload })

    await expect(uploadOfflineInstallerReleaseZip(file)).resolves.toMatchObject({
      version: '2.1.0',
      storageBucket: 'healthflow-offline-installers',
      storagePath: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
    })
    expect(storageFrom).toHaveBeenCalledWith('healthflow-offline-installers')
    expect(upload).toHaveBeenCalledWith(
      'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
      file,
      expect.objectContaining({
        contentType: 'application/zip',
        upsert: false,
      })
    )
  })

  it('uses resumable upload for large installer ZIPs', async () => {
    const file = new File(['healthflow-offline'], 'HealthFlow-Offline-Installer-2.1.0.zip', {
      type: 'application/zip',
    })
    Object.defineProperty(file, 'size', { value: 60 * 1024 * 1024 })
    tusStart.mockImplementation(() => tusState.options.onSuccess())

    await expect(uploadOfflineInstallerReleaseZip(file)).resolves.toMatchObject({
      version: '2.1.0',
      storageBucket: 'healthflow-offline-installers',
      storagePath: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
    })

    expect(storageFrom).not.toHaveBeenCalled()
    expect(TusUpload).toHaveBeenCalledWith(file, expect.objectContaining({
      endpoint: 'https://project-ref.storage.supabase.co/storage/v1/upload/resumable',
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: false,
      removeFingerprintOnSuccess: true,
      headers: expect.objectContaining({
        apikey: 'anon-key-1',
        authorization: 'Bearer access-token-1',
      }),
      metadata: expect.objectContaining({
        bucketName: 'healthflow-offline-installers',
        objectName: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
        contentType: 'application/zip',
        cacheControl: '3600',
      }),
    }))
    expect(tusStart).toHaveBeenCalledTimes(1)
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

  it('saves then runs deep validation when Save and Validate is requested', async () => {
    const file = makeInstallerFile()
    const sha256 = await calculateOfflineInstallerSha256(file)
    download.mockResolvedValue({ data: file, error: null })
    storageFrom.mockReturnValue({ download })

    const savedData = {
      id: 'release-1',
      version: '2.1.0',
      download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
      file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
      file_size: file.size,
      sha256,
      release_notes: 'Initial private installer.',
      state: 'uploaded',
      channel: 'stable',
      validation_status: 'not_validated',
      manifest: {
        version: '2.1.0',
        file_name: 'HealthFlow-Offline-Installer-2.1.0.zip',
        file_size_bytes: file.size,
        sha256,
      },
      storage_bucket: 'healthflow-offline-installers',
      storage_path: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
      enabled: false,
    }
    const saveQuery = makeQuery({ data: savedData })
    const loadQuery = makeQuery({ data: savedData })
    const updateQuery = makeQuery({
      data: {
        ...savedData,
        state: 'validated',
        validation_status: 'valid',
        validation_error: null,
        validated_by: 'user-1',
      },
    })
    from.mockReturnValueOnce(saveQuery).mockReturnValueOnce(loadQuery).mockReturnValueOnce(updateQuery)

    await expect(saveOfflineInstallerRelease({
      version: '2.1.0',
      downloadUrl: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.1.0.zip',
      fileName: 'HealthFlow-Offline-Installer-2.1.0.zip',
      fileSize: file.size,
      sha256,
      releaseNotes: 'Initial private installer.',
      state: 'uploaded',
      manifest: savedData.manifest,
      storageBucket: 'healthflow-offline-installers',
      storagePath: 'releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip',
    }, { validate: true })).resolves.toMatchObject({
      version: '2.1.0',
      state: 'validated',
      validationStatus: 'valid',
      enabled: false,
    })
    expect(saveQuery.upsert.mock.calls[0][0]).toMatchObject({
      state: 'uploaded',
      enabled: false,
    })
    expect(saveQuery.upsert.mock.calls[0][0]).not.toHaveProperty('validation_status', 'valid')
    expect(download).toHaveBeenCalledWith('releases/2.1.0/HealthFlow-Offline-Installer-2.1.0.zip')
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      state: 'validated',
      validation_status: 'valid',
      validated_by: 'user-1',
    }))
  })

  it('publishes only a validated, approved release and records a publish event', async () => {
    const targetQuery = makeQuery({
      data: {
        id: 'release-2',
        channel: 'pilot',
        state: 'validated',
        validation_status: 'valid',
        validation_critical_count: 0,
        approved_by: 'approver-1',
      },
    })
    const disableQuery = makeQuery({ data: [{ id: 'previous-release-1' }] })
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
        channel: 'pilot',
        validation_status: 'valid',
        enabled: true,
      },
    })
    const eventQuery = makeQuery({ data: null, error: null })
    from.mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(disableQuery)
      .mockReturnValueOnce(publishQuery)
      .mockReturnValueOnce(eventQuery)

    await expect(enableOfflineInstallerRelease('release-2')).resolves.toMatchObject({
      version: '2.1.0',
      state: 'published',
      enabled: true,
    })
    expect(disableQuery.update).toHaveBeenCalledWith({ enabled: false, state: 'superseded' })
    expect(disableQuery.eq).toHaveBeenCalledWith('channel', 'pilot')
    expect(publishQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      state: 'published',
    }))
    expect(publishQuery.eq).toHaveBeenCalledWith('state', 'validated')
    expect(eventQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      release_id: 'release-2',
      previous_release_id: 'previous-release-1',
      channel: 'pilot',
      action: 'publish',
      performed_by: 'user-1',
    }))
  })

  it('refuses to publish a release that has not been approved by a second reviewer', async () => {
    const targetQuery = makeQuery({
      data: {
        id: 'release-5',
        channel: 'stable',
        state: 'validated',
        validation_status: 'valid',
        validation_critical_count: 0,
        approved_by: null,
      },
    })
    from.mockReturnValueOnce(targetQuery)

    await expect(enableOfflineInstallerRelease('release-5')).rejects.toThrow(
      'must be approved by a second reviewer'
    )
  })

  it('approves a validated release for publish', async () => {
    const targetQuery = makeQuery({
      data: {
        id: 'release-6',
        state: 'validated',
        validation_status: 'valid',
        validation_critical_count: 0,
        validated_by: 'validator-1',
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'release-6',
        version: '2.6.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.6.0.zip',
        state: 'validated',
        approved_by: 'user-1',
        approved_at: '2026-07-26T00:00:00Z',
      },
    })
    from.mockReturnValueOnce(targetQuery).mockReturnValueOnce(updateQuery)

    await expect(approveOfflineInstallerRelease('release-6', { notes: 'Looks good' })).resolves.toMatchObject({
      approvedBy: 'user-1',
    })
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      approved_by: 'user-1',
      approval_notes: 'Looks good',
    }))
  })

  it('refuses self-approval by the same reviewer who validated the release', async () => {
    const targetQuery = makeQuery({
      data: {
        id: 'release-7',
        state: 'validated',
        validation_status: 'valid',
        validation_critical_count: 0,
        validated_by: 'user-1',
      },
    })
    from.mockReturnValueOnce(targetQuery)

    await expect(approveOfflineInstallerRelease('release-7')).rejects.toThrow(
      'must be a different Super Admin'
    )
  })

  it('rolls back to a previously superseded release and records the reason', async () => {
    const targetQuery = makeQuery({
      data: {
        id: 'release-old',
        channel: 'stable',
        state: 'superseded',
        validation_status: 'valid',
        validation_critical_count: 0,
      },
    })
    const disableQuery = makeQuery({ data: [{ id: 'release-current' }] })
    const publishQuery = makeQuery({
      data: {
        id: 'release-old',
        version: '2.0.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.0.0.zip',
        state: 'published',
        channel: 'stable',
        enabled: true,
      },
    })
    const eventQuery = makeQuery({ data: null, error: null })
    from.mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(disableQuery)
      .mockReturnValueOnce(publishQuery)
      .mockReturnValueOnce(eventQuery)

    await expect(
      rollbackOfflineInstallerRelease('release-old', { reason: 'New version broke sync' })
    ).resolves.toMatchObject({
      version: '2.0.0',
      state: 'published',
    })
    expect(publishQuery.eq).toHaveBeenCalledWith('state', 'superseded')
    expect(eventQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rollback',
      reason: 'New version broke sync',
      previous_release_id: 'release-current',
    }))
  })

  it('requires a reason before rolling back to a superseded release', async () => {
    const targetQuery = makeQuery({
      data: {
        id: 'release-old',
        channel: 'stable',
        state: 'superseded',
        validation_status: 'valid',
        validation_critical_count: 0,
      },
    })
    from.mockReturnValueOnce(targetQuery)

    await expect(
      rollbackOfflineInstallerRelease('release-old', { reason: '  ' })
    ).rejects.toThrow('A rollback reason is required')
  })

  it('validates a saved release and stores a valid result', async () => {
    const file = makeInstallerFile()
    const sha256 = await calculateOfflineInstallerSha256(file)
    download.mockResolvedValue({ data: file, error: null })
    storageFrom.mockReturnValue({ download })

    const loadQuery = makeQuery({
      data: {
        id: 'release-3',
        version: '2.5.0',
        download_url: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
        file_size: file.size,
        sha256,
        release_notes: 'Validated installer package.',
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'not_validated',
        manifest: {
          version: '2.5.0',
          file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
          file_size_bytes: file.size,
          sha256,
        },
        storage_bucket: 'healthflow-offline-installers',
        storage_path: 'releases/2.5.0/HealthFlow-Offline-Installer-2.5.0.zip',
        enabled: false,
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'release-3',
        version: '2.5.0',
        download_url: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
        file_size: file.size,
        sha256,
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

  it('requires release notes before validating an installer for publishing', async () => {
    const loadQuery = makeQuery({
      data: {
        id: 'release-no-notes',
        version: '2.4.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.4.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.4.0.zip',
        file_size: 180000000,
        sha256: 'd'.repeat(64),
        release_notes: '',
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'not_validated',
        manifest: {},
        enabled: false,
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'release-no-notes',
        version: '2.4.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.4.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.4.0.zip',
        file_size: 180000000,
        sha256: 'd'.repeat(64),
        release_notes: '',
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'invalid',
        validation_error: 'Release notes are required before publishing an installer release.',
        enabled: false,
      },
    })
    from.mockReturnValueOnce(loadQuery).mockReturnValueOnce(updateQuery)

    await expect(validateSavedOfflineInstallerRelease('release-no-notes')).resolves.toMatchObject({
      validationStatus: 'invalid',
      validationError: 'Release notes are required before publishing an installer release.',
    })
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
        release_notes: 'Validate metadata failure path.',
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

  it('deep-validates a private installer ZIP and records warnings without blocking publish readiness', async () => {
    const file = makeInstallerFile()
    const sha256 = await calculateOfflineInstallerSha256(file)

    await expect(validateOfflineInstallerArchive({
      file,
      release: {
        version: '2.5.0',
        downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        fileName: 'HealthFlow-Offline-Installer-2.5.0.zip',
        fileSize: file.size,
        sha256,
        releaseNotes: 'Private release validation.',
        installerType: 'offline-installer',
      },
    })).resolves.toMatchObject({
      validationStatus: 'valid',
      counts: {
        critical: 0,
        warning: expect.any(Number),
      },
      report: expect.arrayContaining([
        expect.objectContaining({ name: 'Required files present', result: 'pass' }),
        expect.objectContaining({ name: 'Recommended files present', result: 'warn' }),
      ]),
    })
  })

  it('rejects corrupted or truncated installer ZIP archives', async () => {
    const file = new File(['not-a-zip'], 'HealthFlow-Offline-Installer-2.5.0.zip', { type: 'application/zip' })
    const sha256 = await calculateOfflineInstallerSha256(file)

    await expect(validateOfflineInstallerArchive({
      file,
      release: {
        version: '2.5.0',
        downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        fileName: 'HealthFlow-Offline-Installer-2.5.0.zip',
        fileSize: file.size,
        sha256,
        releaseNotes: 'Corrupt package test.',
      },
    })).rejects.toThrow('Installer ZIP is too small')
  })

  it('flags checksum mismatch, missing required files, and prohibited secret files as critical validation failures', async () => {
    const file = makeInstallerFile([
      'local-branch-server/Install-HealthFlow.cmd',
      'local-branch-server/.env',
    ])

    await expect(validateOfflineInstallerArchive({
      file,
      release: {
        version: '2.5.0',
        downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        fileName: 'HealthFlow-Offline-Installer-2.5.0.zip',
        fileSize: file.size,
        sha256: '0'.repeat(64),
        releaseNotes: 'Bad package test.',
      },
    })).resolves.toMatchObject({
      validationStatus: 'invalid',
      counts: { critical: expect.any(Number) },
      report: expect.arrayContaining([
        expect.objectContaining({ name: 'SHA-256 checksum matches', result: 'fail' }),
        expect.objectContaining({ name: 'Required files present', result: 'fail' }),
        expect.objectContaining({ name: 'Sensitive-file scan passed', result: 'fail' }),
      ]),
    })
  })

  it('rejects ZIP entries that could escape the installer extraction folder', async () => {
    const file = makeInstallerFile([
      ...REQUIRED_ZIP_ENTRIES,
      '../outside.ps1',
      'local-branch-server/../../Windows/System32/evil.dll',
      'C:/Windows/System32/evil.dll',
    ])
    const sha256 = await calculateOfflineInstallerSha256(file)

    await expect(validateOfflineInstallerArchive({
      file,
      release: {
        version: '2.5.0',
        downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        fileName: 'HealthFlow-Offline-Installer-2.5.0.zip',
        fileSize: file.size,
        sha256,
        releaseNotes: 'Path safety package test.',
      },
    })).resolves.toMatchObject({
      validationStatus: 'invalid',
      report: expect.arrayContaining([
        expect.objectContaining({
          name: 'Archive paths are safe',
          result: 'fail',
          severity: 'critical',
        }),
      ]),
    })

    expect(findUnsafeZipEntryPaths([
      { name: 'local-branch-server/Install-HealthFlow.cmd' },
      { name: '..\\outside.ps1' },
    ])).toEqual(['../outside.ps1'])
  })

  it('rejects archives with entries that decompress far beyond their compressed size', async () => {
    const entries = REQUIRED_ZIP_ENTRIES.map((name) => ({ name, compressedSize: 100, uncompressedSize: 100 }))
    entries.push({ name: 'local-branch-server/bomb.bin', compressedSize: 100, uncompressedSize: 500000 })
    const bytes = makeTestZipWithSizes(entries)
    const file = new File([bytes], 'HealthFlow-Offline-Installer-2.5.0.zip', { type: 'application/zip' })
    const sha256 = await calculateOfflineInstallerSha256(file)

    await expect(validateOfflineInstallerArchive({
      file,
      release: {
        version: '2.5.0',
        downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        fileName: 'HealthFlow-Offline-Installer-2.5.0.zip',
        fileSize: file.size,
        sha256,
        releaseNotes: 'Archive bomb test.',
      },
    })).resolves.toMatchObject({
      validationStatus: 'invalid',
      report: expect.arrayContaining([
        expect.objectContaining({ name: 'Archive size is within safe limits', result: 'fail', severity: 'critical' }),
      ]),
    })

    expect(findArchiveBombEntries([
      { compressedSize: 100, uncompressedSize: 100 },
      { compressedSize: 100, uncompressedSize: 500000 },
    ])).toHaveLength(1)
  })

  it('allows environment example templates while still passing sensitive-file validation', async () => {
    const file = makeInstallerFile([
      ...REQUIRED_ZIP_ENTRIES,
      'local-branch-server/.env.linux.example',
    ])
    const sha256 = await calculateOfflineInstallerSha256(file)

    await expect(validateOfflineInstallerArchive({
      file,
      release: {
        version: '2.5.0',
        downloadUrl: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        fileName: 'HealthFlow-Offline-Installer-2.5.0.zip',
        fileSize: file.size,
        sha256,
        releaseNotes: 'Template package test.',
      },
    })).resolves.toMatchObject({
      report: expect.arrayContaining([
        expect.objectContaining({ name: 'Sensitive-file scan passed', result: 'pass' }),
      ]),
    })
  })

  it('downloads the private ZIP when validating a saved release', async () => {
    const file = makeInstallerFile()
    const sha256 = await calculateOfflineInstallerSha256(file)
    download.mockResolvedValue({ data: file, error: null })
    storageFrom.mockReturnValue({ download })

    const loadQuery = makeQuery({
      data: {
        id: 'release-private',
        version: '2.5.0',
        download_url: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
        file_size: file.size,
        sha256,
        release_notes: 'Private release validation.',
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'not_validated',
        manifest: {
          version: '2.5.0',
          file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
          file_size_bytes: file.size,
          sha256,
          installer_type: 'offline-installer',
        },
        storage_bucket: 'healthflow-offline-installers',
        storage_path: 'releases/2.5.0/HealthFlow-Offline-Installer-2.5.0.zip',
        installer_type: 'offline-installer',
        enabled: false,
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'release-private',
        version: '2.5.0',
        download_url: 'https://healthflowcloud.com/offline-installer/HealthFlow-Offline-Installer-2.5.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
        file_size: file.size,
        sha256,
        release_notes: 'Private release validation.',
        state: 'validated',
        channel: 'stable',
        validation_status: 'valid',
        validation_report: [],
        validation_critical_count: 0,
        validation_warning_count: 1,
        validation_info_count: 0,
        enabled: false,
      },
    })
    from.mockReturnValueOnce(loadQuery).mockReturnValueOnce(updateQuery)

    await expect(validateSavedOfflineInstallerRelease('release-private')).resolves.toMatchObject({
      state: 'validated',
      validationStatus: 'valid',
    })
    expect(storageFrom).toHaveBeenCalledWith('healthflow-offline-installers')
    expect(download).toHaveBeenCalledWith('releases/2.5.0/HealthFlow-Offline-Installer-2.5.0.zip')
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      validation_status: 'valid',
      validation_critical_count: 0,
      validation_warning_count: expect.any(Number),
      validated_by: 'user-1',
    }))
  })

  it('does not validate external installer URLs without private archive inspection', async () => {
    const loadQuery = makeQuery({
      data: {
        id: 'external-release',
        version: '2.5.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.5.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
        file_size: 180000000,
        sha256: 'd'.repeat(64),
        release_notes: 'External URL package test.',
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'not_validated',
        manifest: {},
        storage_bucket: null,
        storage_path: null,
        enabled: false,
      },
    })
    const updateQuery = makeQuery({
      data: {
        id: 'external-release',
        version: '2.5.0',
        download_url: 'https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-2.5.0.zip',
        file_name: 'HealthFlow-Offline-Installer-2.5.0.zip',
        file_size: 180000000,
        sha256: 'd'.repeat(64),
        release_notes: 'External URL package test.',
        state: 'uploaded',
        channel: 'stable',
        validation_status: 'invalid',
        validation_error: 'Upload the installer ZIP to private HealthFlow storage before validation. External URLs cannot be published.',
        validation_report: [],
        validation_critical_count: 1,
        enabled: false,
      },
    })
    from.mockReturnValueOnce(loadQuery).mockReturnValueOnce(updateQuery)

    await expect(validateSavedOfflineInstallerRelease('external-release')).resolves.toMatchObject({
      validationStatus: 'invalid',
      validationError: 'Upload the installer ZIP to private HealthFlow storage before validation. External URLs cannot be published.',
    })
    expect(download).not.toHaveBeenCalled()
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      validation_status: 'invalid',
      validation_critical_count: 1,
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
