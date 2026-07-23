import { supabase } from '../lib/supabase'
import { validateHealthflowInstallerUrl } from '../config/branchUpdateConfig'
import { tryLogAuditEvent } from './auditService'
import { invokeTierAccess } from './tierAccessService'

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

const isMissingInstallerLifecycleColumn = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === '42703' &&
    (
      message.includes('offline_installer_releases.state') ||
      message.includes('offline_installer_releases.channel') ||
      message.includes('offline_installer_releases.validation_status') ||
      message.includes('offline_installer_releases.manifest') ||
      message.includes('offline_installer_releases.storage_bucket') ||
      message.includes('offline_installer_releases.storage_path')
    )
  )
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
  let { data, error } = await supabase
    .from('offline_installer_releases')
    .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
    .eq('state', INSTALLER_RELEASE_STATES.PUBLISHED)
    .eq('enabled', true)
    .eq('channel', 'stable')
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error && isMissingInstallerLifecycleColumn(error)) {
    ;({ data, error } = await supabase
      .from('offline_installer_releases')
      .select(OFFLINE_INSTALLER_RELEASE_LEGACY_FIELDS)
      .eq('enabled', true)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle())
  }

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
  let { data, error } = await supabase
    .from('offline_installer_releases')
    .select(OFFLINE_INSTALLER_RELEASE_FIELDS)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (error && isMissingInstallerLifecycleColumn(error)) {
    ;({ data, error } = await supabase
      .from('offline_installer_releases')
      .select(OFFLINE_INSTALLER_RELEASE_LEGACY_FIELDS)
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }))
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

export const validateOfflineInstallerReleasePayload = (payload, { requireUrl = true } = {}) => {
  const validation = validateHealthflowInstallerUrl(payload.download_url)
  if (requireUrl && !validation.valid) {
    throw new Error(`Installer download URL is invalid: ${validation.reason}.`)
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
    const payload = buildOfflineInstallerReleasePayload(row)
    validateOfflineInstallerReleasePayload(payload, { requireUrl: true })
    if ([INSTALLER_RELEASE_STATES.DISABLED, INSTALLER_RELEASE_STATES.SUPERSEDED].includes(row.state)) {
      throw new Error('Disabled or superseded releases cannot be validated for publishing.')
    }

    const { data, error } = await supabase
      .from('offline_installer_releases')
      .update({
        ...baseUpdate,
        state: INSTALLER_RELEASE_STATES.VALIDATED,
        validation_status: 'valid',
        validation_error: null,
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
        validation_status: 'valid',
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
  const { error: disableError } = await supabase
    .from('offline_installer_releases')
    .update({ enabled: false, state: INSTALLER_RELEASE_STATES.SUPERSEDED })
    .eq('enabled', true)
    .eq('channel', 'stable')

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
