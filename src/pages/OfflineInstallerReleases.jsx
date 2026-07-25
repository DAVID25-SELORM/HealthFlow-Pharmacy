import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ClipboardCopy, Download, RotateCcw, Save, ToggleLeft, UploadCloud } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import {
  disableOfflineInstallerRelease,
  enableOfflineInstallerRelease,
  buildOfflineInstallerReleaseFromManifest,
  INSTALLER_RELEASE_CHANNELS,
  INSTALLER_RELEASE_STATES,
  listOfflineInstallerReleases,
  saveOfflineInstallerRelease,
  uploadOfflineInstallerReleaseZip,
  validateSavedOfflineInstallerRelease,
} from '../services/offlineInstallerReleaseService'
import './OfflineInstallerReleases.css'

const blankForm = {
  version: '',
  downloadUrl: '',
  fileName: '',
  fileSize: '',
  sha256: '',
  releaseNotes: '',
  state: INSTALLER_RELEASE_STATES.DRAFT,
  channel: 'stable',
  validationStatus: 'not_validated',
  manifest: {},
  storageBucket: '',
  storagePath: '',
}

const formatBytes = (bytes) => {
  const value = Number(bytes || 0)
  if (!value) return '-'
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`
  return `${value} B`
}

const formatDate = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

const formatChannel = (value) => String(value || 'stable').replace(/_/g, ' ')

const formatChecksum = (value) => {
  const checksum = String(value || '').trim()
  if (!checksum) return 'Checksum not recorded'
  return `${checksum.slice(0, 12)}...${checksum.slice(-8)}`
}

const canPublishRelease = (release) => (
  release?.state === INSTALLER_RELEASE_STATES.VALIDATED &&
  release?.validationStatus === 'valid' &&
  Number(release?.validationCriticalCount || 0) === 0
)

const validationTone = (check) => {
  if (check?.result === 'pass') return 'pass'
  return check?.severity === 'critical' ? 'fail' : 'warn'
}

export default function OfflineInstallerReleases() {
  const { role } = useAuth()
  const { notify } = useNotification()
  const [releases, setReleases] = useState([])
  const [form, setForm] = useState(blankForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const isSuperAdmin = String(role || '').toLowerCase() === 'super_admin'
  const activeRelease = useMemo(
    () => releases.find((release) => release.enabled && release.state === INSTALLER_RELEASE_STATES.PUBLISHED),
    [releases]
  )

  const loadReleases = async () => {
    setLoading(true)
    try {
      setReleases(await listOfflineInstallerReleases())
    } catch (error) {
      notify(error.message || 'Unable to load offline installer releases.', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isSuperAdmin) void loadReleases()
  }, [isSuperAdmin])

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const importManifest = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      const manifestRelease = buildOfflineInstallerReleaseFromManifest(parsed)
      setForm((current) => ({
        ...current,
        ...manifestRelease,
        downloadUrl: current.downloadUrl,
        releaseNotes: current.releaseNotes,
      }))
      notify('Installer manifest imported. Add the HTTPS ZIP URL, then save and validate.', 'success')
    } catch (error) {
      notify(error.message || 'Unable to import installer manifest.', 'error')
    }
  }

  const uploadInstallerZip = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setSaving(true)
    try {
      const uploadedRelease = await uploadOfflineInstallerReleaseZip(file, {
        releaseNotes: form.releaseNotes,
        channel: form.channel || 'stable',
      })
      await saveOfflineInstallerRelease(uploadedRelease)
      setForm((current) => ({
        ...blankForm,
        ...uploadedRelease,
        releaseNotes: current.releaseNotes || uploadedRelease.releaseNotes || '',
      }))
      await loadReleases()
      notify('Installer ZIP uploaded privately. Add release notes, validate it, then publish when ready.', 'success')
    } catch (error) {
      notify(error.message || 'Unable to upload installer ZIP.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const registerRelease = async (event, { validate = false } = {}) => {
    event.preventDefault()
    setSaving(true)
    try {
      await saveOfflineInstallerRelease(form, { validate })
      setForm(blankForm)
      await loadReleases()
      notify(validate ? 'Offline installer release validated.' : 'Offline installer release saved.', 'success')
    } catch (error) {
      notify(error.message || 'Unable to save offline installer release.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const disableActiveRelease = async () => {
    if (!activeRelease) return
    setSaving(true)
    try {
      await disableOfflineInstallerRelease(activeRelease.id)
      await loadReleases()
      notify('Offline installer downloads disabled.', 'success')
    } catch (error) {
      notify(error.message || 'Unable to disable installer downloads.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const enableRelease = async (release) => {
    setSaving(true)
    try {
      await enableOfflineInstallerRelease(release.id)
      await loadReleases()
      notify(`Offline installer ${release.version} is now published.`, 'success')
    } catch (error) {
      notify(error.message || 'Unable to enable installer release.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const validateRelease = async (release) => {
    setSaving(true)
    try {
      const validated = await validateSavedOfflineInstallerRelease(release.id)
      await loadReleases()
      if (validated?.validationStatus === 'valid') {
        notify(`Offline installer ${release.version} validated.`, 'success')
      } else {
        notify(validated?.validationError || 'Installer release validation failed.', 'error')
      }
    } catch (error) {
      notify(error.message || 'Unable to validate installer release.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const copyDownloadUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url)
      notify('Download URL copied.', 'success')
    } catch {
      notify('Unable to copy the download URL.', 'error')
    }
  }

  const copyChecksum = async (checksum) => {
    try {
      await navigator.clipboard.writeText(checksum)
      notify('Checksum copied.', 'success')
    } catch {
      notify('Unable to copy the checksum.', 'error')
    }
  }

  if (!isSuperAdmin) {
    return (
      <div className="offline-installer-release-page">
        <div className="offline-installer-release-card">
          <h1>Offline Installer Releases</h1>
          <p>Only platform Super Admin users can manage installer releases.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="offline-installer-release-page">
      <header className="offline-installer-release-header">
        <div>
          <h1>Offline Installer Releases</h1>
          <p>Validate, publish, disable, and roll back approved HealthFlow offline installers.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void loadReleases()} disabled={loading}>
          Refresh
        </button>
      </header>

      <section className="offline-installer-release-card active-release-card">
        <div>
          <span className="release-eyebrow">Current active installer</span>
          <h2>{activeRelease ? `Version ${activeRelease.version}` : 'Downloads disabled'}</h2>
          <p>
            {activeRelease
              ? `Published ${formatDate(activeRelease.publishedAt)}. ${formatBytes(activeRelease.fileSize)}.`
              : 'No installer release is currently enabled for facility users.'}
          </p>
        </div>
        <div className="active-release-actions">
          {activeRelease && (
            <>
              <button className="btn btn-outline" type="button" onClick={() => void copyDownloadUrl(activeRelease.downloadUrl)}>
                <ClipboardCopy size={16} /> Copy URL
              </button>
              <button className="btn btn-warning" type="button" onClick={() => void disableActiveRelease()} disabled={saving}>
                <ToggleLeft size={16} /> Disable Downloads
              </button>
            </>
          )}
        </div>
      </section>

      <section className="offline-installer-release-card">
        <h2>Register Installer Version</h2>
        <div className="manifest-import-panel installer-upload-panel">
          <div>
            <strong>Upload installer ZIP</strong>
            <p>
              Choose <code>HealthFlow-Offline-Installer-&lt;version&gt;.zip</code>. HealthFlow calculates the version,
              file size, and SHA-256, stores the ZIP privately, then creates a draft release.
            </p>
          </div>
          <label className={`btn btn-primary manifest-import-button${saving ? ' disabled' : ''}`}>
            <UploadCloud size={16} /> Upload ZIP
            <input type="file" accept="application/zip,.zip" onChange={uploadInstallerZip} disabled={saving} />
          </label>
        </div>
        <div className="manifest-import-panel">
          <div>
            <strong>Import release manifest</strong>
            <p>Use the JSON manifest generated by <code>npm run release:offline-installer</code> to fill version, file name, size, and checksum.</p>
          </div>
          <label className="btn btn-outline manifest-import-button">
            <UploadCloud size={16} /> Import Manifest
            <input type="file" accept="application/json,.json" onChange={importManifest} />
          </label>
        </div>
        <form className="installer-release-form" onSubmit={(event) => registerRelease(event)}>
          <label>
            <span>Version</span>
            <input value={form.version} onChange={(event) => updateForm('version', event.target.value)} placeholder="1.4.4" required />
          </label>
          <label>
            <span>Download URL</span>
            <input value={form.downloadUrl} onChange={(event) => updateForm('downloadUrl', event.target.value)} placeholder="https://.../HealthFlow-Offline-Installer-1.4.4.zip" required />
          </label>
          <label>
            <span>File name</span>
            <input value={form.fileName} onChange={(event) => updateForm('fileName', event.target.value)} placeholder="HealthFlow-Offline-Installer-1.4.4.zip" required />
          </label>
          <label>
            <span>File size bytes</span>
            <input type="number" min="1" value={form.fileSize} onChange={(event) => updateForm('fileSize', event.target.value)} placeholder="47219500" required />
          </label>
          <label>
            <span>State</span>
            <select value={form.state} onChange={(event) => updateForm('state', event.target.value)}>
              <option value={INSTALLER_RELEASE_STATES.DRAFT}>Draft</option>
              <option value={INSTALLER_RELEASE_STATES.UPLOADED}>Uploaded</option>
            </select>
          </label>
          <label>
            <span>Channel</span>
            <select value={form.channel} onChange={(event) => updateForm('channel', event.target.value)}>
              <option value={INSTALLER_RELEASE_CHANNELS.INTERNAL}>Internal</option>
              <option value={INSTALLER_RELEASE_CHANNELS.PILOT}>Pilot</option>
              <option value={INSTALLER_RELEASE_CHANNELS.STABLE}>Stable</option>
            </select>
          </label>
          <label>
            <span>Private storage bucket</span>
            <input value={form.storageBucket} onChange={(event) => updateForm('storageBucket', event.target.value)} placeholder="Optional: offline-installers" />
          </label>
          <label>
            <span>Private storage path</span>
            <input value={form.storagePath} onChange={(event) => updateForm('storagePath', event.target.value)} placeholder="Optional: releases/HealthFlow-Offline-Installer-1.4.4.zip" />
          </label>
          <label className="wide">
            <span>SHA-256 checksum</span>
            <input value={form.sha256} onChange={(event) => updateForm('sha256', event.target.value)} placeholder="64-character checksum" required />
          </label>
          <label className="wide">
            <span>Release notes</span>
            <textarea value={form.releaseNotes} onChange={(event) => updateForm('releaseNotes', event.target.value)} rows={3} placeholder="What changed in this installer?" />
          </label>
          <div className="installer-form-actions">
            <button className="btn btn-outline" type="button" onClick={() => setForm(blankForm)} disabled={saving}>
              Clear
            </button>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              <Save size={16} /> Save Release
            </button>
            <button className="btn btn-success" type="button" disabled={saving} onClick={(event) => registerRelease(event, { validate: true })}>
              <CheckCircle2 size={16} /> Save and Validate
            </button>
          </div>
        </form>
      </section>

      <section className="offline-installer-release-card">
        <h2>Release History</h2>
        {loading ? (
          <p>Loading installer releases...</p>
        ) : releases.length === 0 ? (
          <p>No installer releases have been registered yet.</p>
        ) : (
          <div className="installer-release-table">
            <div className="installer-release-row header">
              <span>Version</span>
              <span>File</span>
              <span>Size</span>
              <span>State</span>
              <span>Channel</span>
              <span>Validation</span>
              <span>Actions</span>
            </div>
            {releases.map((release) => (
              <div className="installer-release-row" key={release.id}>
                <span>
                  <strong>{release.version}</strong>
                  <small>{formatDate(release.publishedAt || release.createdAt)}</small>
                  <small>{Number(release.downloadCount || 0)} download request{Number(release.downloadCount || 0) === 1 ? '' : 's'}</small>
                </span>
                <span>{release.fileName}</span>
                <span>
                  {formatBytes(release.fileSize)}
                  <small>{Number(release.fileSize || 0).toLocaleString()} bytes</small>
                  <small title={release.sha256 || ''}>{formatChecksum(release.sha256)}</small>
                </span>
                <span className={`release-state ${release.state}`}>
                  {release.enabled ? <><CheckCircle2 size={14} /> Published</> : release.state}
                </span>
                <span className="release-channel">{formatChannel(release.channel)}</span>
                <span className={release.validationStatus === 'valid' ? 'release-enabled' : 'release-disabled'}>
                  {release.validationStatus}
                  <small>{Number(release.validationCriticalCount || 0)} critical, {Number(release.validationWarningCount || 0)} warning</small>
                  {release.validationError && <small>{release.validationError}</small>}
                </span>
                <span className="row-actions">
                  <button className="btn btn-icon" type="button" title="Copy download URL" onClick={() => void copyDownloadUrl(release.downloadUrl)}>
                    <ClipboardCopy size={15} />
                  </button>
                  <button className="btn btn-icon" type="button" title="Copy checksum" onClick={() => void copyChecksum(release.sha256)}>
                    #
                  </button>
                  <a className="btn btn-icon" title="Open download URL" href={release.downloadUrl} target="_blank" rel="noreferrer">
                    <Download size={15} />
                  </a>
                  {['draft', 'uploaded'].includes(release.state) && (
                    <button className="btn btn-icon" type="button" title="Validate release" disabled={saving} onClick={() => void validateRelease(release)}>
                      <CheckCircle2 size={15} />
                    </button>
                  )}
                  {!release.enabled && canPublishRelease(release) && (
                    <button className="btn btn-icon" type="button" title="Publish this release" disabled={saving} onClick={() => void enableRelease(release)}>
                      <RotateCcw size={15} />
                    </button>
                  )}
                </span>
                {Array.isArray(release.validationReport) && release.validationReport.length > 0 && (
                  <div className="release-validation-report">
                    {release.validationReport.map((check, index) => (
                      <div className={`validation-check ${validationTone(check)}`} key={`${release.id}-check-${index}`}>
                        <strong>{check.name}</strong>
                        <span>{check.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
