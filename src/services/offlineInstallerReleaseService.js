import * as tus from 'tus-js-client'
import { validateHealthflowInstallerUrl } from '../config/branchUpdateConfig'
import { tryLogAuditEvent } from './auditService'
import { invokeTierAccess } from './tierAccessService'
import {
  getCachedSupabaseSession,
  getConfiguredCloudUrl,
  getConfiguredSupabaseKey,
  supabase,
} from '../lib/supabase'

export const OFFLINE_INSTALLER_PRIVATE_BUCKET = 'healthflow-offline-installers'
export const OFFLINE_INSTALLER_FILE_PATTERN = /^HealthFlow-Offline-Installer-([0-9A-Za-z][0-9A-Za-z._-]*)\.zip$/
const OFFLINE_INSTALLER_PRIVATE_DOWNLOAD_BASE = 'https://healthflowcloud.com/offline-installer'
const STANDARD_STORAGE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024
const RESUMABLE_STORAGE_CHUNK_SIZE_BYTES = 6 * 1024 * 1024
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50

export const INSTALLER_RELEASE_CHANNELS = {
  INTERNAL: 'internal',
  PILOT: 'pilot',
  STABLE: 'stable',
}

export const INSTALLER_VALIDATION_SEVERITIES = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'informational',
}

export const REQUIRED_INSTALLER_ZIP_ENTRIES = [
  'local-branch-server/Install-HealthFlow.cmd',
  'local-branch-server/package.json',
  'local-branch-server/public/index.html',
  'local-branch-server/scripts/install-windows-service.ps1',
  'local-branch-server/scripts/start-healthflow-offline.cmd',
  'local-branch-server/src/schema.sql',
  'local-branch-server/src/server.js',
]

const RECOMMENDED_INSTALLER_ZIP_ENTRIES = [
  'local-branch-server/runtime/node/node.exe',
  'local-branch-server/README.md',
]

const PROHIBITED_INSTALLER_ENTRY_PATTERNS = [
  { pattern: /(^|\/)\.env$/i, label: 'Environment file' },
  { pattern: /(^|\/)\.env\.(?!example$)[^/]+$/i, label: 'Environment file' },
  { pattern: /service[-_]?role/i, label: 'Service-role key reference' },
  { pattern: /branch[-_]?token/i, label: 'Branch token reference' },
  { pattern: /(^|\/)([^/]+\.)?(sqlite|sqlite3|db|db3)$/i, label: 'Local database file' },
  { pattern: /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|private[-_]?key)(\.|$)/i, label: 'Private key file' },
  { pattern: /\.(pem|pfx|p12|key)$/i, label: 'Private certificate or key' },
  { pattern: /(^|\/)(\.vite|\.turbo|\.next|coverage|\.cache)(\/|$)/i, label: 'Development cache' },
]

export const INSTALLER_INSTALLATION_STATUSES = [
  'download_requested',
  'installer_started',
  'installer_completed',
  'service_started',
  'machine_registered',
  'initial_sync_started',
  'initial_sync_completed',
  'readiness_passed',
  'installation_failed',
]

export const OFFLINE_INSTALLER_RELEASE_FIELDS = [
  'id',
  'version',
  'download_url',
  'file_name',
  'file_size',
  'sha256',
  'release_notes',
  'state',
  'channel',
  'validation_status',
  'validation_checked_at',
  'validation_error',
  'validation_report',
  'validation_critical_count',
  'validation_warning_count',
  'validation_info_count',
  'validated_by',
  'manifest',
  'storage_bucket',
  'storage_path',
  'download_count',
  'last_downloaded_at',
  'built_at',
  'git_commit',
  'git_branch',
  'installer_type',
  'minimum_supported_app_version',
  'minimum_supported_local_server_version',
  'enabled',
  'published_at',
  'published_by',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
].join(',')

const OFFLINE_INSTALLER_RELEASE_LEGACY_FIELDS = [
  'id',
  'version',
  'download_url',
  'file_name',
  'file_size',
  'sha256',
  'release_notes',
  'enabled',
  'published_at',
  'published_by',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
].join(',')

export const INSTALLER_RELEASE_STATES = {
  DRAFT: 'draft',
  UPLOADED: 'uploaded',
  VALIDATED: 'validated',
  PUBLISHED: 'published',
  DISABLED: 'disabled',
  SUPERSEDED: 'superseded',
}

const isPublishedRelease = (row) =>
  row?.state === INSTALLER_RELEASE_STATES.PUBLISHED || row?.enabled === true

const hasReleaseSchemaDriftError = (error) => {
  const message = String(error?.message || error?.details || '')
  return error?.code === '42703' || /column .* does not exist/i.test(message)
}

const normalizeInstallerRelease = (row, { includeDisabled = false } = {}) => {
  if (!row || (!includeDisabled && !isPublishedRelease(row))) return null

  const validation = validateHealthflowInstallerUrl(row.download_url)
  if (!validation.valid) return null

  return {
    id: row.id,
    version: row.version,
    downloadUrl: row.download_url,
    fileName: row.file_name,
    fileSize: row.file_size,
    sha256: row.sha256,
    releaseNotes: row.release_notes || '',
    state: row.state || (row.enabled ? INSTALLER_RELEASE_STATES.PUBLISHED : INSTALLER_RELEASE_STATES.DISABLED),
    channel: row.channel || 'stable',
    validationStatus: row.validation_status || 'not_validated',
    validationCheckedAt: row.validation_checked_at,
    validationError: row.validation_error || '',
    validationReport: Array.isArray(row.validation_report) ? row.validation_report : [],
    validationCriticalCount: Number(row.validation_critical_count || 0),
    validationWarningCount: Number(row.validation_warning_count || 0),
    validationInfoCount: Number(row.validation_info_count || 0),
    validatedBy: row.validated_by || null,
    manifest: row.manifest || {},
    storageBucket: row.storage_bucket || '',
    storagePath: row.storage_path || '',
    downloadCount: Number(row.download_count || 0),
    lastDownloadedAt: row.last_downloaded_at,
    builtAt: row.built_at,
    gitCommit: row.git_commit,
    gitBranch: row.git_branch,
    installerType: row.installer_type,
    minimumSupportedAppVersion: row.minimum_supported_app_version,
    minimumSupportedLocalServerVersion: row.minimum_supported_local_server_version,
    enabled: row.enabled,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

export const getActiveOfflineInstallerRelease = async () => {
  const { data, error } = await supabase
    .from('offline_installer_releases')
    .select(OFFLINE_INSTALLER_RELEASE_LEGACY_FIELDS)
    .eq('enabled', true)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[Offline installer] Runtime release config could not be loaded.', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    })
    return null
  }

  return normalizeInstallerRelease(data)
}

export const listOfflineInstallerReleases = async () => {
  const runQuery = (fields) => supabase
    .from('offline_installer_releases')
    .select(fields)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  let { data, error } = await runQuery(OFFLINE_INSTALLER_RELEASE_FIELDS)
  if (error && hasReleaseSchemaDriftError(error)) {
    ;({ data, error } = await runQuery(OFFLINE_INSTALLER_RELEASE_LEGACY_FIELDS))
  }

  if (error) throw error
  return (data || []).map((row) => normalizeInstallerRelease(row, { includeDisabled: true })).filter(Boolean)
}

export const buildOfflineInstallerReleasePayload = (release) => ({
  version: String(release.version || '').trim(),
  download_url: String(release.downloadUrl || release.download_url || '').trim(),
  file_name: String(release.fileName || release.file_name || '').trim(),
  file_size: Number(release.fileSize || release.file_size || 0),
  sha256: String(release.sha256 || '').trim().toLowerCase(),
  release_notes: String(release.releaseNotes || release.release_notes || '').trim() || null,
  state: String(release.state || release.release_state || INSTALLER_RELEASE_STATES.DRAFT).trim(),
  channel: String(release.channel || 'stable').trim(),
  validation_status: String(release.validationStatus || release.validation_status || 'not_validated').trim(),
  validation_checked_at: release.validationCheckedAt || release.validation_checked_at || null,
  validation_error: release.validationError || release.validation_error || null,
  validation_report: Array.isArray(release.validationReport || release.validation_report)
    ? (release.validationReport || release.validation_report)
    : [],
  validation_critical_count: Number(release.validationCriticalCount || release.validation_critical_count || 0),
  validation_warning_count: Number(release.validationWarningCount || release.validation_warning_count || 0),
  validation_info_count: Number(release.validationInfoCount || release.validation_info_count || 0),
  manifest: release.manifest || {},
  storage_bucket: String(release.storageBucket || release.storage_bucket || '').trim() || null,
  storage_path: String(release.storagePath || release.storage_path || '').trim() || null,
  built_at: release.builtAt || release.built_at || null,
  git_commit: release.gitCommit || release.git_commit || null,
  git_branch: release.gitBranch || release.git_branch || null,
  installer_type: release.installerType || release.installer_type || null,
  minimum_supported_app_version:
    release.minimumSupportedAppVersion || release.minimum_supported_app_version || null,
  minimum_supported_local_server_version:
    release.minimumSupportedLocalServerVersion || release.minimum_supported_local_server_version || null,
  enabled: Boolean(release.enabled) && String(release.state || '').trim() === INSTALLER_RELEASE_STATES.PUBLISHED,
})

export const buildOfflineInstallerReleaseFromManifest = (manifest) => {
  const normalizedManifest = manifest && typeof manifest === 'object' ? manifest : {}
  return {
    version: normalizedManifest.version || '',
    fileName: normalizedManifest.file_name || '',
    fileSize: normalizedManifest.file_size_bytes || '',
    sha256: normalizedManifest.sha256 || '',
    state: INSTALLER_RELEASE_STATES.UPLOADED,
    channel: 'stable',
    validationStatus: 'not_validated',
    manifest: normalizedManifest,
    builtAt: normalizedManifest.built_at || null,
    gitCommit: normalizedManifest.git_commit || null,
    gitBranch: normalizedManifest.git_branch || null,
    installerType: normalizedManifest.installer_type || null,
    minimumSupportedAppVersion: normalizedManifest.minimum_supported_app_version || null,
    minimumSupportedLocalServerVersion:
      normalizedManifest.minimum_supported_local_server_version || null,
  }
}

export const extractOfflineInstallerVersionFromFileName = (fileName) => {
  const normalized = String(fileName || '').trim()
  const match = normalized.match(OFFLINE_INSTALLER_FILE_PATTERN)
  if (!match) {
    throw new Error('Installer ZIP must be named HealthFlow-Offline-Installer-<version>.zip.')
  }
  return match[1]
}

export const calculateOfflineInstallerSha256 = async (file) => {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Select a valid installer ZIP file.')
  }
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const decodeZipEntryName = (bytes) => {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return Array.from(bytes).map((byte) => String.fromCharCode(byte)).join('')
  }
}

export const listZipEntries = async (fileOrBlob) => {
  if (!fileOrBlob || typeof fileOrBlob.arrayBuffer !== 'function') {
    throw new Error('Select a readable installer ZIP file.')
  }
  const buffer = await fileOrBlob.arrayBuffer()
  if (buffer.byteLength < 22) {
    throw new Error('Installer ZIP is too small to contain a valid archive.')
  }

  const view = new DataView(buffer)
  const minOffset = Math.max(0, buffer.byteLength - 65557)
  let eocdOffset = -1
  for (let offset = buffer.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Installer ZIP central directory could not be found.')
  }

  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  if (
    centralDirectoryOffset <= 0 ||
    centralDirectorySize <= 0 ||
    centralDirectoryOffset + centralDirectorySize > buffer.byteLength
  ) {
    throw new Error('Installer ZIP central directory is truncated or invalid.')
  }

  const entries = []
  let offset = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Installer ZIP entry table is truncated or invalid.')
    }
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const fileNameOffset = offset + 46
    const nextOffset = fileNameOffset + fileNameLength + extraLength + commentLength
    if (fileNameOffset + fileNameLength > buffer.byteLength || nextOffset > buffer.byteLength) {
      throw new Error('Installer ZIP entry name table is truncated.')
    }
    const nameBytes = new Uint8Array(buffer, fileNameOffset, fileNameLength)
    const name = decodeZipEntryName(nameBytes).replace(/\\/g, '/')
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      isDirectory: name.endsWith('/'),
    })
    offset = nextOffset
  }
  return entries
}

const buildValidationCheck = ({ name, result, severity, message }) => ({
  name,
  result,
  severity,
  message,
})

const countValidationChecks = (report = []) => ({
  critical: report.filter((check) => check.severity === INSTALLER_VALIDATION_SEVERITIES.CRITICAL && check.result !== 'pass').length,
  warning: report.filter((check) => check.severity === INSTALLER_VALIDATION_SEVERITIES.WARNING && check.result !== 'pass').length,
  info: report.filter((check) => check.severity === INSTALLER_VALIDATION_SEVERITIES.INFO && check.result !== 'pass').length,
})

const validateEntriesAgainstRelease = ({ entries, payload, actualSize, actualSha256 }) => {
  const names = new Set(entries.map((entry) => entry.name))
  const report = []
  const expectedVersion = extractOfflineInstallerVersionFromFileName(payload.file_name)

  report.push(buildValidationCheck({
    name: 'Uploaded object exists',
    result: actualSize > 0 ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: actualSize > 0 ? 'Installer archive is available.' : 'Installer archive could not be loaded.',
  }))
  report.push(buildValidationCheck({
    name: 'File size matches',
    result: Number(payload.file_size) === Number(actualSize) ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: Number(payload.file_size) === Number(actualSize)
      ? 'Recorded file size matches the uploaded archive.'
      : 'Recorded file size does not match the uploaded archive.',
  }))
  report.push(buildValidationCheck({
    name: 'SHA-256 checksum matches',
    result: String(payload.sha256).toLowerCase() === String(actualSha256).toLowerCase() ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: String(payload.sha256).toLowerCase() === String(actualSha256).toLowerCase()
      ? 'Recorded checksum matches the uploaded archive.'
      : 'Recorded checksum does not match the uploaded archive.',
  }))
  report.push(buildValidationCheck({
    name: 'Archive readable',
    result: entries.length > 0 ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: entries.length > 0
      ? `ZIP central directory is readable with ${entries.length} entries.`
      : 'ZIP archive has no readable entries.',
  }))
  report.push(buildValidationCheck({
    name: 'Filename version verified',
    result: expectedVersion === payload.version ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: expectedVersion === payload.version
      ? 'Filename version matches release version.'
      : 'Filename version does not match release version.',
  }))

  const missingRequired = REQUIRED_INSTALLER_ZIP_ENTRIES.filter((entry) => !names.has(entry))
  report.push(buildValidationCheck({
    name: 'Required files present',
    result: missingRequired.length === 0 ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: missingRequired.length === 0
      ? 'Required installer files are present.'
      : `Missing required installer files: ${missingRequired.join(', ')}`,
  }))

  const missingRecommended = RECOMMENDED_INSTALLER_ZIP_ENTRIES.filter((entry) => !names.has(entry))
  report.push(buildValidationCheck({
    name: 'Recommended files present',
    result: missingRecommended.length === 0 ? 'pass' : 'warn',
    severity: INSTALLER_VALIDATION_SEVERITIES.WARNING,
    message: missingRecommended.length === 0
      ? 'Recommended installer files are present.'
      : `Recommended installer files were not found: ${missingRecommended.join(', ')}`,
  }))

  const prohibited = entries
    .map((entry) => entry.name)
    .filter((entryName) => PROHIBITED_INSTALLER_ENTRY_PATTERNS.some(({ pattern }) => pattern.test(entryName)))
  report.push(buildValidationCheck({
    name: 'Sensitive-file scan passed',
    result: prohibited.length === 0 ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: prohibited.length === 0
      ? 'No prohibited secret, token, database, certificate, or cache filenames were found.'
      : `Prohibited installer entries were found: ${prohibited.slice(0, 8).join(', ')}${prohibited.length > 8 ? ', ...' : ''}`,
  }))

  const manifest = payload.manifest && typeof payload.manifest === 'object' ? payload.manifest : {}
  const manifestChecks = [
    !manifest.version || manifest.version === payload.version,
    !manifest.file_name || manifest.file_name === payload.file_name,
    !manifest.file_size_bytes || Number(manifest.file_size_bytes) === Number(actualSize),
    !manifest.sha256 || String(manifest.sha256).toLowerCase() === String(actualSha256).toLowerCase(),
  ]
  report.push(buildValidationCheck({
    name: 'Manifest matches metadata',
    result: manifestChecks.every(Boolean) ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: manifestChecks.every(Boolean)
      ? 'Package manifest metadata matches the uploaded archive.'
      : 'Package manifest metadata does not match the uploaded archive.',
  }))

  report.push(buildValidationCheck({
    name: 'Installer type supported',
    result: !payload.installer_type || payload.installer_type === 'offline-installer' ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: !payload.installer_type || payload.installer_type === 'offline-installer'
      ? 'Installer type is supported.'
      : 'Installer type is not supported.',
  }))
  report.push(buildValidationCheck({
    name: 'Target platform supported',
    result: names.has('local-branch-server/Install-HealthFlow.cmd') ? 'pass' : 'warn',
    severity: INSTALLER_VALIDATION_SEVERITIES.WARNING,
    message: names.has('local-branch-server/Install-HealthFlow.cmd')
      ? 'Windows installer entry point is present.'
      : 'Windows installer entry point was not found.',
  }))
  report.push(buildValidationCheck({
    name: 'Release notes present',
    result: String(payload.release_notes || '').trim() ? 'pass' : 'fail',
    severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
    message: String(payload.release_notes || '').trim()
      ? 'Release notes are present.'
      : 'Release notes are required before publication.',
  }))

  return report
}

export const validateOfflineInstallerArchive = async ({ file, release }) => {
  const payload = buildOfflineInstallerReleasePayload(release)
  validateOfflineInstallerReleasePayload(payload, { requireUrl: true })
  const [actualSha256, entries] = await Promise.all([
    calculateOfflineInstallerSha256(file),
    listZipEntries(file),
  ])
  const report = validateEntriesAgainstRelease({
    entries,
    payload,
    actualSize: Number(file?.size || 0),
    actualSha256,
  })
  const counts = countValidationChecks(report)
  return {
    report,
    counts,
    validationStatus: counts.critical > 0 ? 'invalid' : 'valid',
    validationError: counts.critical > 0
      ? report.find((check) => check.severity === INSTALLER_VALIDATION_SEVERITIES.CRITICAL && check.result !== 'pass')?.message
      : null,
  }
}

const validateExternalInstallerMetadata = (release) => {
  const payload = buildOfflineInstallerReleasePayload(release)
  validateOfflineInstallerReleasePayload(payload, { requireUrl: true, requireReleaseNotes: true })
  const report = [
    buildValidationCheck({
      name: 'Metadata is valid',
      result: 'pass',
      severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
      message: 'Release metadata is internally consistent.',
    }),
    buildValidationCheck({
      name: 'Archive validation skipped',
      result: 'warn',
      severity: INSTALLER_VALIDATION_SEVERITIES.WARNING,
      message: 'This release uses an external HTTPS URL, so the private ZIP contents could not be inspected.',
    }),
  ]
  const counts = countValidationChecks(report)
  return {
    report,
    counts,
    validationStatus: 'valid',
    validationError: null,
  }
}
export const buildOfflineInstallerReleaseFromZipFile = async (
  file,
  {
    bucket = OFFLINE_INSTALLER_PRIVATE_BUCKET,
    channel = 'stable',
    releaseNotes = '',
  } = {}
) => {
  const fileName = String(file?.name || '').trim()
  const version = extractOfflineInstallerVersionFromFileName(fileName)
  if (!fileName.toLowerCase().endsWith('.zip')) {
    throw new Error('Offline installer upload must be a ZIP file.')
  }
  const fileSize = Number(file?.size || 0)
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error('Offline installer ZIP is empty.')
  }
  const sha256 = await calculateOfflineInstallerSha256(file)
  const storagePath = `releases/${version}/${fileName}`
  const downloadUrl = `${OFFLINE_INSTALLER_PRIVATE_DOWNLOAD_BASE}/${encodeURIComponent(fileName)}`
  return {
    version,
    downloadUrl,
    fileName,
    fileSize,
    sha256,
    releaseNotes,
    state: INSTALLER_RELEASE_STATES.UPLOADED,
    channel,
    validationStatus: 'not_validated',
    validationCheckedAt: null,
    validationError: null,
    manifest: {
      version,
      file_name: fileName,
      file_size_bytes: fileSize,
      sha256,
      installer_type: 'offline-installer',
      storage_bucket: bucket,
      storage_path: storagePath,
      uploaded_at: new Date().toISOString(),
    },
    storageBucket: bucket,
    storagePath,
    installerType: 'offline-installer',
  }
}

export const uploadOfflineInstallerReleaseZip = async (
  file,
  options = {}
) => {
  const release = await buildOfflineInstallerReleaseFromZipFile(file, options)
  if (Number(file?.size || 0) > STANDARD_STORAGE_UPLOAD_LIMIT_BYTES) {
    await uploadOfflineInstallerReleaseZipResumable(release, file)
    return release
  }

  const { error } = await supabase.storage
    .from(release.storageBucket)
    .upload(release.storagePath, file, {
      cacheControl: '3600',
      contentType: 'application/zip',
      upsert: false,
    })

  if (error) throw error
  return release
}

export const uploadOfflineInstallerReleaseZipResumable = (release, file) => new Promise((resolve, reject) => {
  const cloudUrl = String(getConfiguredCloudUrl() || '').replace(/\/+$/, '')
  const supabaseKey = getConfiguredSupabaseKey()
  const accessToken = getCachedSupabaseSession()?.access_token

  if (!cloudUrl || !supabaseKey || !accessToken) {
    reject(new Error('Unable to start large installer upload because the authenticated Supabase session is not ready.'))
    return
  }

  const upload = new tus.Upload(file, {
    endpoint: `${cloudUrl}/storage/v1/upload/resumable`,
    retryDelays: [0, 1000, 3000, 5000],
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${accessToken}`,
    },
    metadata: {
      bucketName: release.storageBucket,
      objectName: release.storagePath,
      contentType: 'application/zip',
      cacheControl: '3600',
    },
    chunkSize: RESUMABLE_STORAGE_CHUNK_SIZE_BYTES,
    uploadDataDuringCreation: false,
    removeFingerprintOnSuccess: true,
    onError: reject,
    onSuccess: resolve,
  })

  upload.start()
})

export const validateOfflineInstallerReleasePayload = (
  payload,
  { requireUrl = true, requireReleaseNotes = false } = {}
) => {
  const validation = validateHealthflowInstallerUrl(payload.download_url)
  if (requireUrl && !validation.valid) {
    throw new Error(`Installer download URL is invalid: ${validation.reason}.`)
  }
  if (requireReleaseNotes && !String(payload.release_notes || '').trim()) {
    throw new Error('Release notes are required before publishing an installer release.')
  }
  if (!payload.version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(payload.version)) {
    throw new Error('Installer version is missing or invalid.')
  }
  const expectedFileName = `HealthFlow-Offline-Installer-${payload.version}.zip`
  if (payload.file_name !== expectedFileName) {
    throw new Error(`Installer file name must be ${expectedFileName}.`)
  }
  if (!Number.isFinite(payload.file_size) || payload.file_size <= 0) {
    throw new Error('Installer file size must be greater than zero.')
  }
  if (!/^[a-f0-9]{64}$/.test(payload.sha256)) {
    throw new Error('Installer SHA-256 must be a 64-character hexadecimal checksum.')
  }
  if (payload.manifest && Object.keys(payload.manifest).length > 0) {
    if (payload.manifest.version && payload.manifest.version !== payload.version) {
      throw new Error('Manifest version does not match the release version.')
    }
    if (payload.manifest.file_name && payload.manifest.file_name !== payload.file_name) {
      throw new Error('Manifest file name does not match the release file name.')
    }
    if (
      payload.manifest.file_size_bytes &&
      Number(payload.manifest.file_size_bytes) !== Number(payload.file_size)
    ) {
      throw new Error('Manifest file size does not match the release file size.')
    }
    if (
      payload.manifest.sha256 &&
      String(payload.manifest.sha256).toLowerCase() !== payload.sha256
    ) {
      throw new Error('Manifest checksum does not match the release checksum.')
    }
  }
  if ((payload.storage_bucket && !payload.storage_path) || (!payload.storage_bucket && payload.storage_path)) {
    throw new Error('Private storage bucket and path must be supplied together.')
  }
  return true
}

export const saveOfflineInstallerRelease = async (release, { validate = false } = {}) => {
  const payload = buildOfflineInstallerReleasePayload(release)
  validateOfflineInstallerReleasePayload(payload, { requireUrl: true })
  if (payload.state === INSTALLER_RELEASE_STATES.PUBLISHED) {
    throw new Error('Save as validated first, then publish the release.')
  }
  if (validate) {
    validateOfflineInstallerReleasePayload(payload, { requireUrl: true, requireReleaseNotes: true })
    payload.state = INSTALLER_RELEASE_STATES.VALIDATED
    payload.validation_status = 'valid'
    payload.validation_checked_at = new Date().toISOString()
    payload.validation_error = null
  }
  payload.enabled = false

  const { data, error } = await supabase
    .from('offline_installer_releases')
    .upsert(payload, { onConflict: 'version' })
    .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
    .single()

  if (error) throw error
  await tryLogAuditEvent({
    eventType: 'offline_installer_release',
    entityType: 'offline_installer_release',
    entityId: data?.id,
    action: payload.enabled ? 'installer_release.enabled' : 'installer_release.saved',
    details: {
      version: payload.version,
      file_name: payload.file_name,
      file_size: payload.file_size,
      sha256: payload.sha256,
      state: payload.state,
      channel: payload.channel,
      validation_status: payload.validation_status,
    },
  })
  return normalizeInstallerRelease(data, { includeDisabled: true })
}

export const validateSavedOfflineInstallerRelease = async (id) => {
  const { data: row, error: loadError } = await supabase
    .from('offline_installer_releases')
    .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
    .eq('id', id)
    .single()

  if (loadError) throw loadError

  const baseUpdate = {
    validation_checked_at: new Date().toISOString(),
  }

  try {
    if ([INSTALLER_RELEASE_STATES.DISABLED, INSTALLER_RELEASE_STATES.SUPERSEDED].includes(row.state)) {
      throw new Error('Disabled or superseded releases cannot be validated for publishing.')
    }

    let validationResult
    if (row.storage_bucket && row.storage_path) {
      const { data: archive, error: downloadError } = await supabase.storage
        .from(row.storage_bucket)
        .download(row.storage_path)
      if (downloadError) throw downloadError
      validationResult = await validateOfflineInstallerArchive({ file: archive, release: row })
    } else {
      validationResult = validateExternalInstallerMetadata(row)
    }

    const { data: userData } = await supabase.auth.getUser()
    const { report, counts, validationStatus, validationError } = validationResult

    const { data, error } = await supabase
      .from('offline_installer_releases')
      .update({
        ...baseUpdate,
        state: validationStatus === 'valid' ? INSTALLER_RELEASE_STATES.VALIDATED : row.state,
        validation_status: validationStatus,
        validation_error: validationError,
        validation_report: report,
        validation_critical_count: counts.critical,
        validation_warning_count: counts.warning,
        validation_info_count: counts.info,
        validated_by: userData?.user?.id || null,
        enabled: false,
      })
      .eq('id', id)
      .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
      .single()

    if (error) throw error
    await tryLogAuditEvent({
      eventType: 'offline_installer_release',
      entityType: 'offline_installer_release',
      entityId: id,
      action: 'installer_release.validated',
      details: {
        version: data?.version,
        file_name: data?.file_name,
        validation_status: data?.validation_status,
        validation_critical_count: data?.validation_critical_count || 0,
        validation_warning_count: data?.validation_warning_count || 0,
      },
    })
    return normalizeInstallerRelease(data, { includeDisabled: true })
  } catch (validationError) {
    const message = validationError.message || 'Installer release validation failed.'
    const { data, error } = await supabase
      .from('offline_installer_releases')
      .update({
        ...baseUpdate,
        validation_status: 'invalid',
        validation_error: message,
        validation_report: [buildValidationCheck({
          name: 'Validation failed',
          result: 'fail',
          severity: INSTALLER_VALIDATION_SEVERITIES.CRITICAL,
          message,
        })],
        validation_critical_count: 1,
        validation_warning_count: 0,
        validation_info_count: 0,
        enabled: false,
      })
      .eq('id', id)
      .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
      .single()

    if (error) throw error
    await tryLogAuditEvent({
      eventType: 'offline_installer_release',
      entityType: 'offline_installer_release',
      entityId: id,
      action: 'installer_release.validation_failed',
      details: {
        version: data?.version || row?.version,
        file_name: data?.file_name || row?.file_name,
        validation_status: 'invalid',
        validation_error: message,
      },
    })
    return normalizeInstallerRelease(data, { includeDisabled: true })
  }
}

export const disableOfflineInstallerRelease = async (id) => {
  const { data, error } = await supabase
    .from('offline_installer_releases')
    .update({ enabled: false, state: INSTALLER_RELEASE_STATES.DISABLED })
    .eq('id', id)
    .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
    .single()

  if (error) throw error
  await tryLogAuditEvent({
    eventType: 'offline_installer_release',
    entityType: 'offline_installer_release',
    entityId: id,
    action: 'installer_release.disabled',
    details: {
      version: data?.version,
      file_name: data?.file_name,
    },
  })
  return normalizeInstallerRelease(data, { includeDisabled: true })
}

export const enableOfflineInstallerRelease = async (id) => {
  const { data: targetRelease, error: targetError } = await supabase
    .from('offline_installer_releases')
    .select('id, channel')
    .eq('id', id)
    .single()

  if (targetError) throw targetError
  const channel = targetRelease?.channel || 'stable'

  const { error: disableError } = await supabase
    .from('offline_installer_releases')
    .update({ enabled: false, state: INSTALLER_RELEASE_STATES.SUPERSEDED })
    .eq('enabled', true)
    .eq('channel', channel)

  if (disableError) throw disableError

  const { data, error } = await supabase
    .from('offline_installer_releases')
    .update({
      enabled: true,
      state: INSTALLER_RELEASE_STATES.PUBLISHED,
      published_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('state', INSTALLER_RELEASE_STATES.VALIDATED)
    .eq('validation_status', 'valid')
    .eq('validation_critical_count', 0)
    .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
    .single()

  if (error) throw error
  await tryLogAuditEvent({
    eventType: 'offline_installer_release',
    entityType: 'offline_installer_release',
    entityId: id,
    action: 'installer_release.enabled',
    details: {
      version: data?.version,
      file_name: data?.file_name,
      sha256: data?.sha256,
      channel: data?.channel || channel,
    },
  })
  return normalizeInstallerRelease(data, { includeDisabled: true })
}

export const requestOfflineInstallerDownload = async () => {
  const response = await invokeTierAccess({ action: 'request_offline_installer_download' })
  const release = response?.release || {}
  return {
    downloadUrl: response?.downloadUrl || response?.download_url || '',
    expiresAt: response?.expiresAt || response?.expires_at || null,
    source: response?.source || 'url',
    release: {
      version: release.version || '',
      fileName: release.fileName || release.file_name || '',
      fileSize: release.fileSize || release.file_size || null,
      publishedAt: release.publishedAt || release.published_at || null,
      releaseNotes: release.releaseNotes || release.release_notes || '',
    },
  }
}




export const recordOfflineInstallerInstallationStatus = async ({
  releaseId,
  status,
  organizationId = null,
  branchId = null,
  syncClientId = null,
  installerVersion = '',
  machineLabel = '',
  details = {},
} = {}) => {
  if (!INSTALLER_INSTALLATION_STATUSES.includes(status)) {
    throw new Error('Unsupported offline installer installation status.')
  }
  const safeDetails = Object.fromEntries(
    Object.entries(details || {}).filter(([key]) => !/(token|secret|password|signed|authorization|header|url)/i.test(key))
  )
  const { data: userData } = await supabase.auth.getUser()
  const payload = {
    release_id: releaseId || null,
    organization_id: organizationId || null,
    branch_id: branchId || null,
    sync_client_id: syncClientId || null,
    event_status: status,
    installer_version: installerVersion || null,
    machine_label: machineLabel || null,
    details: safeDetails,
    created_by: userData?.user?.id || null,
  }

  const { data, error } = await supabase
    .from('offline_installer_installation_events')
    .insert(payload)
    .select('id, event_status, created_at')
    .single()

  if (error) {
    console.warn('[Offline installer] Installation status could not be recorded.', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    })
    return null
  }
  return data
}
