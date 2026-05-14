import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, RefreshCcw, Server, UploadCloud } from 'lucide-react'
import {
  createNhiaBatch,
  downloadNhiaBatchExport,
  getBranchServerConfig,
  getBranchServerHealth,
  getBranchSyncStatus,
  getNhiaSettings,
  getNhiaSummary,
  listNhiaClaims,
  pullBranchInventory,
  pullBranchReferenceData,
  runBranchSync,
  saveNhiaSettings,
  submitPendingNhiaClaims,
} from '../services/branchServerApi'
import { useNotification } from '../context/NotificationContext'
import './OfflineSync.css'

const ENTITY_LABELS = {
  patients: 'Patients',
  claims: 'Claims',
  nhis_drugs: 'NHIS Drugs',
  nhis_claims: 'NHIS Claims',
  suppliers: 'Suppliers',
  purchases: 'Purchases',
}

const EVENT_LABELS = {
  'sale.completed': 'POS Sales',
  'claim.submitted': 'POS Claims',
  'record.upsert': 'Module Records',
}

const formatDateTime = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

const getSummaryTotal = (summary, key) => Number(summary?.[key] || 0)

const blankNhiaForm = {
  facilityCode: '',
  providerNumber: '',
  submitterId: '',
  apiBaseUrl: '',
  claimEndpointPath: '/claims',
  directApiEnabled: false,
  credentialMode: 'api_key',
  exportFormat: 'json',
  nhisMemberDigits: 8,
  ghanaCardDigits: 10,
  maxRetryAttempts: 3,
  credentials: {
    apiKey: '',
    headerName: '',
    headerPrefix: '',
    clientId: '',
    clientSecret: '',
    username: '',
    password: '',
    certPem: '',
    keyPem: '',
    caPem: '',
    passphrase: '',
  },
}

const buildNhiaForm = (settings) => ({
  ...blankNhiaForm,
  ...(settings || {}),
  credentials: { ...blankNhiaForm.credentials },
})

export default function OfflineSync() {
  const { notify } = useNotification()
  const [config, setConfig] = useState(() => getBranchServerConfig())
  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')
  const [entityFilter, setEntityFilter] = useState('all')
  const [nhiaSettings, setNhiaSettings] = useState(null)
  const [nhiaSummary, setNhiaSummary] = useState(null)
  const [nhiaClaims, setNhiaClaims] = useState([])
  const [nhiaForm, setNhiaForm] = useState(blankNhiaForm)

  const refreshStatus = useCallback(async ({ silent = false } = {}) => {
    const nextConfig = getBranchServerConfig()
    setConfig(nextConfig)
    setError('')

    if (!nextConfig.enabled || !nextConfig.token) {
      setHealth(null)
      setStatus(null)
      setNhiaSettings(null)
      setNhiaSummary(null)
      setNhiaClaims([])
      setLoading(false)
      setError('Local branch server is not configured in this browser.')
      return
    }

    try {
      setLoading(true)
      const [nextHealth, nextStatus, nextNhiaSettings, nextNhiaSummary, nextNhiaClaims] = await Promise.all([
        getBranchServerHealth(),
        getBranchSyncStatus(),
        getNhiaSettings().catch(() => null),
        getNhiaSummary().catch(() => null),
        listNhiaClaims({ limit: 8 }).catch(() => []),
      ])
      setHealth(nextHealth)
      setStatus(nextStatus)
      setNhiaSettings(nextNhiaSettings)
      setNhiaSummary(nextNhiaSummary)
      setNhiaClaims(nextNhiaClaims)
      setNhiaForm(buildNhiaForm(nextNhiaSettings))
      if (!silent) {
        notify('Offline sync status refreshed.', 'success')
      }
    } catch (statusError) {
      setHealth(null)
      setStatus(null)
      setNhiaSettings(null)
      setNhiaSummary(null)
      setNhiaClaims([])
      setError(statusError.message || 'Unable to reach local branch server.')
      if (!silent) {
        notify(statusError.message || 'Unable to reach local branch server.', 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void refreshStatus({ silent: true })
  }, [refreshStatus])

  const recordEntries = useMemo(
    () =>
      Object.entries(status?.recordsByEntity || {}).filter(
        ([entityType]) => entityFilter === 'all' || entityType === entityFilter
      ),
    [entityFilter, status]
  )

  const eventEntries = useMemo(
    () => Object.entries(status?.eventsByType || {}),
    [status]
  )

  const runAction = async (action, label, operation) => {
    try {
      setBusyAction(action)
      const result = await operation()
      await refreshStatus({ silent: true })
      if (action === 'sync') {
        notify(
          `Checked ${result.total || 0} event${result.total === 1 ? '' : 's'}: ${result.synced || 0} synced, ${result.failed || 0} failed.`,
          result.failed ? 'warning' : 'success'
        )
      } else {
        notify(`${label} completed.`, 'success')
      }
    } catch (actionError) {
      notify(actionError.message || `${label} failed.`, 'error')
    } finally {
      setBusyAction('')
    }
  }

  const updateNhiaForm = (field, value) => {
    setNhiaForm((current) => ({ ...current, [field]: value }))
  }

  const updateNhiaCredential = (field, value) => {
    setNhiaForm((current) => ({
      ...current,
      credentials: { ...current.credentials, [field]: value },
    }))
  }

  const saveNhiaForm = async () => {
    await runAction('nhia-settings', 'NHIA settings save', async () => {
      const saved = await saveNhiaSettings(nhiaForm)
      setNhiaSettings(saved)
      setNhiaForm(buildNhiaForm(saved))
      return saved
    })
  }

  const submitNhiaClaims = async () => {
    await runAction('nhia-submit', 'NHIA pending claims submission', submitPendingNhiaClaims)
  }

  const downloadTextFile = ({ content, contentType, fileName }) => {
    const blob = new Blob([content], { type: contentType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const exportNhiaBatch = async (format) => {
    await runAction('nhia-export', `NHIA ${format.toUpperCase()} export`, async () => {
      const batch = await createNhiaBatch({ exportFormat: format })
      const exported = await downloadNhiaBatchExport(batch.id, format)
      downloadTextFile(exported)
      return batch
    })
  }

  const recentRecordFailures = status?.recentFailures?.records || []
  const recentEventFailures = status?.recentFailures?.events || []
  const hasFailures = recentRecordFailures.length > 0 || recentEventFailures.length > 0
  const isConnected = Boolean(health?.ok)

  return (
    <div className="offline-sync-page">
      <div className="offline-sync-header">
        <div>
          <h1>Offline Sync</h1>
          <p>Monitor local branch server queues, module records, and failed sync attempts.</p>
        </div>
        <div className={`offline-sync-connection ${isConnected ? 'online' : 'offline'}`}>
          <Server size={18} />
          <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>

      {error && <div className="offline-sync-alert">{error}</div>}

      <div className="offline-sync-actions">
        <button className="btn btn-outline" type="button" onClick={() => refreshStatus()} disabled={loading || Boolean(busyAction)}>
          <RefreshCcw size={16} />
          {loading ? 'Checking...' : 'Refresh'}
        </button>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => runAction('sync', 'Sync', runBranchSync)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          <UploadCloud size={16} />
          {busyAction === 'sync' ? 'Syncing...' : 'Sync Now'}
        </button>
        <button
          className="btn btn-outline"
          type="button"
          onClick={() => runAction('inventory', 'Inventory pull', pullBranchInventory)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          Pull Inventory
        </button>
        <button
          className="btn btn-outline"
          type="button"
          onClick={() => runAction('reference', 'Reference data pull', pullBranchReferenceData)}
          disabled={!isConnected || Boolean(busyAction)}
        >
          Pull Reference Data
        </button>
      </div>

      <section className="offline-sync-overview">
        <div className="sync-metric">
          <span>Pending</span>
          <strong>{getSummaryTotal(status, 'pending')}</strong>
        </div>
        <div className="sync-metric warning">
          <span>Failed</span>
          <strong>{getSummaryTotal(status, 'failed')}</strong>
        </div>
        <div className="sync-metric">
          <span>Synced</span>
          <strong>{getSummaryTotal(status, 'synced')}</strong>
        </div>
        <div className="sync-metric">
          <span>Total Events</span>
          <strong>{getSummaryTotal(status, 'total')}</strong>
        </div>
      </section>

      <section className="offline-sync-section">
        <div className="offline-sync-section-header">
          <div>
            <h2>NHIA / CLAIM-it</h2>
            <p>Local claim settings, submission status, and batch export.</p>
          </div>
          <div className="offline-sync-actions">
            <button
              className="btn btn-outline"
              type="button"
              onClick={submitNhiaClaims}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Submit Pending
            </button>
            <button
              className="btn btn-outline"
              type="button"
              onClick={() => exportNhiaBatch('json')}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Export JSON
            </button>
            <button
              className="btn btn-outline"
              type="button"
              onClick={() => exportNhiaBatch('xml')}
              disabled={!isConnected || Boolean(busyAction)}
            >
              Export XML
            </button>
          </div>
        </div>

        <div className="nhia-settings-grid">
          <label>
            <span>Facility Code</span>
            <input
              value={nhiaForm.facilityCode}
              onChange={(event) => updateNhiaForm('facilityCode', event.target.value)}
            />
          </label>
          <label>
            <span>Provider Number</span>
            <input
              value={nhiaForm.providerNumber}
              onChange={(event) => updateNhiaForm('providerNumber', event.target.value)}
            />
          </label>
          <label>
            <span>Submitter ID</span>
            <input
              value={nhiaForm.submitterId}
              onChange={(event) => updateNhiaForm('submitterId', event.target.value)}
            />
          </label>
          <label>
            <span>API Base URL</span>
            <input
              value={nhiaForm.apiBaseUrl}
              onChange={(event) => updateNhiaForm('apiBaseUrl', event.target.value)}
            />
          </label>
          <label>
            <span>Claim Endpoint</span>
            <input
              value={nhiaForm.claimEndpointPath}
              onChange={(event) => updateNhiaForm('claimEndpointPath', event.target.value)}
            />
          </label>
          <label>
            <span>Credential Mode</span>
            <select
              value={nhiaForm.credentialMode}
              onChange={(event) => updateNhiaForm('credentialMode', event.target.value)}
            >
              <option value="api_key">API Key</option>
              <option value="client_secret">Client ID / Secret</option>
              <option value="username_password">Username / Password</option>
              <option value="certificate">Certificate</option>
            </select>
          </label>
          <label>
            <span>Export Format</span>
            <select
              value={nhiaForm.exportFormat}
              onChange={(event) => updateNhiaForm('exportFormat', event.target.value)}
            >
              <option value="json">JSON</option>
              <option value="xml">XML</option>
            </select>
          </label>
          <label>
            <span>NHIS Digits</span>
            <input
              type="number"
              min="1"
              max="30"
              value={nhiaForm.nhisMemberDigits}
              onChange={(event) => updateNhiaForm('nhisMemberDigits', event.target.value)}
            />
          </label>
          <label>
            <span>Ghana Card Digits</span>
            <input
              type="number"
              min="1"
              max="30"
              value={nhiaForm.ghanaCardDigits}
              onChange={(event) => updateNhiaForm('ghanaCardDigits', event.target.value)}
            />
          </label>
          <label>
            <span>Retry Attempts</span>
            <input
              type="number"
              min="1"
              max="10"
              value={nhiaForm.maxRetryAttempts}
              onChange={(event) => updateNhiaForm('maxRetryAttempts', event.target.value)}
            />
          </label>
          <label className="nhia-toggle">
            <input
              type="checkbox"
              checked={Boolean(nhiaForm.directApiEnabled)}
              onChange={(event) => updateNhiaForm('directApiEnabled', event.target.checked)}
            />
            <span>Direct API Enabled</span>
          </label>

          {nhiaForm.credentialMode === 'api_key' && (
            <>
              <label className="nhia-wide">
                <span>API Key {nhiaSettings?.credentialSummary?.apiKey ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.apiKey}
                  onChange={(event) => updateNhiaCredential('apiKey', event.target.value)}
                />
              </label>
              <label>
                <span>API Key Header</span>
                <input
                  value={nhiaForm.credentials.headerName}
                  placeholder="Authorization"
                  onChange={(event) => updateNhiaCredential('headerName', event.target.value)}
                />
              </label>
              <label>
                <span>Header Prefix</span>
                <input
                  value={nhiaForm.credentials.headerPrefix}
                  placeholder="Bearer"
                  onChange={(event) => updateNhiaCredential('headerPrefix', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'client_secret' && (
            <>
              <label>
                <span>Client ID {nhiaSettings?.credentialSummary?.clientId ? '(saved)' : ''}</span>
                <input
                  value={nhiaForm.credentials.clientId}
                  onChange={(event) => updateNhiaCredential('clientId', event.target.value)}
                />
              </label>
              <label>
                <span>Client Secret {nhiaSettings?.credentialSummary?.clientSecret ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.clientSecret}
                  onChange={(event) => updateNhiaCredential('clientSecret', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'username_password' && (
            <>
              <label>
                <span>Username {nhiaSettings?.credentialSummary?.username ? '(saved)' : ''}</span>
                <input
                  value={nhiaForm.credentials.username}
                  onChange={(event) => updateNhiaCredential('username', event.target.value)}
                />
              </label>
              <label>
                <span>Password {nhiaSettings?.credentialSummary?.password ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.password}
                  onChange={(event) => updateNhiaCredential('password', event.target.value)}
                />
              </label>
            </>
          )}

          {nhiaForm.credentialMode === 'certificate' && (
            <>
              <label className="nhia-wide">
                <span>Certificate PEM {nhiaSettings?.credentialSummary?.certPem ? '(saved)' : ''}</span>
                <textarea
                  rows="4"
                  value={nhiaForm.credentials.certPem}
                  onChange={(event) => updateNhiaCredential('certPem', event.target.value)}
                />
              </label>
              <label className="nhia-wide">
                <span>Private Key PEM {nhiaSettings?.credentialSummary?.keyPem ? '(saved)' : ''}</span>
                <textarea
                  rows="4"
                  value={nhiaForm.credentials.keyPem}
                  onChange={(event) => updateNhiaCredential('keyPem', event.target.value)}
                />
              </label>
              <label>
                <span>Passphrase {nhiaSettings?.credentialSummary?.passphrase ? '(saved)' : ''}</span>
                <input
                  type="password"
                  value={nhiaForm.credentials.passphrase}
                  onChange={(event) => updateNhiaCredential('passphrase', event.target.value)}
                />
              </label>
              <label className="nhia-wide">
                <span>CA PEM {nhiaSettings?.credentialSummary?.caPem ? '(saved)' : ''}</span>
                <textarea
                  rows="3"
                  value={nhiaForm.credentials.caPem}
                  onChange={(event) => updateNhiaCredential('caPem', event.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className="nhia-settings-footer">
          <span>
            Draft {nhiaSummary?.draft || 0} | Ready {nhiaSummary?.ready || 0} | Submitted{' '}
            {nhiaSummary?.submitted || 0} | Failed {nhiaSummary?.failed || 0}
          </span>
          <button
            className="btn btn-primary"
            type="button"
            onClick={saveNhiaForm}
            disabled={!isConnected || Boolean(busyAction)}
          >
            {busyAction === 'nhia-settings' ? 'Saving...' : 'Save NHIA Settings'}
          </button>
        </div>

        <div className="nhia-claims-table-wrap">
          {nhiaClaims.length === 0 ? (
            <div className="sync-empty">No local NHIA claims found.</div>
          ) : (
            <table className="nhia-claims-table">
              <thead>
                <tr>
                  <th>Claim</th>
                  <th>Patient</th>
                  <th>Member No.</th>
                  <th>Status</th>
                  <th>CC Code</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {nhiaClaims.map((claim) => (
                  <tr key={claim.id}>
                    <td>{claim.claimNumber}</td>
                    <td>{claim.patientName}</td>
                    <td>{claim.memberNumber}</td>
                    <td>{claim.status}</td>
                    <td>{claim.ccCode || '-'}</td>
                    <td>GHS {Number(claim.totalAmount || 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="offline-sync-section">
        <div className="offline-sync-section-header">
          <div>
            <h2>Module Records</h2>
            <p>Pending / failed / synced records stored by the branch server.</p>
          </div>
          <select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}>
            <option value="all">All modules</option>
            {Object.keys(status?.recordsByEntity || {}).map((entityType) => (
              <option key={entityType} value={entityType}>
                {ENTITY_LABELS[entityType] || entityType}
              </option>
            ))}
          </select>
        </div>

        <div className="sync-record-grid">
          {recordEntries.length === 0 ? (
            <div className="sync-empty">No branch module records found.</div>
          ) : (
            recordEntries.map(([entityType, summary]) => (
              <div className="sync-record-row" key={entityType}>
                <strong>{ENTITY_LABELS[entityType] || entityType}</strong>
                <span>{summary.pending || 0} pending</span>
                <span>{summary.failed || 0} failed</span>
                <span>{summary.synced || 0} synced</span>
                <span>{summary.total || 0} total</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="offline-sync-section">
        <div className="offline-sync-section-header">
          <div>
            <h2>Outbox Events</h2>
            <p>Sync events waiting to be pushed to Supabase.</p>
          </div>
        </div>
        <div className="sync-record-grid">
          {eventEntries.length === 0 ? (
            <div className="sync-empty">No outbox events found.</div>
          ) : (
            eventEntries.map(([eventType, summary]) => (
              <div className="sync-record-row" key={eventType}>
                <strong>{EVENT_LABELS[eventType] || eventType}</strong>
                <span>{summary.pending || 0} pending</span>
                <span>{summary.syncing || 0} syncing</span>
                <span>{summary.failed || 0} failed</span>
                <span>{summary.synced || 0} synced</span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className={`offline-sync-section ${hasFailures ? 'has-failures' : ''}`}>
        <div className="offline-sync-section-header">
          <div>
            <h2>Failures</h2>
            <p>Most recent records or outbox events that need attention.</p>
          </div>
          {hasFailures ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
        </div>

        {!hasFailures ? (
          <div className="sync-empty success">No recent sync failures.</div>
        ) : (
          <div className="sync-failure-tables">
            {recentRecordFailures.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Module</th>
                    <th>Updated</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRecordFailures.map((failure) => (
                    <tr key={`${failure.entity_type}-${failure.id}`}>
                      <td>{failure.id}</td>
                      <td>{ENTITY_LABELS[failure.entity_type] || failure.entity_type}</td>
                      <td>{formatDateTime(failure.updated_at)}</td>
                      <td>{failure.last_sync_error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {recentEventFailures.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Entity</th>
                    <th>Updated</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEventFailures.map((failure) => (
                    <tr key={failure.id}>
                      <td>{EVENT_LABELS[failure.event_type] || failure.event_type}</td>
                      <td>{ENTITY_LABELS[failure.entity_type] || failure.entity_type}</td>
                      <td>{formatDateTime(failure.updated_at)}</td>
                      <td>{failure.last_error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <p className="offline-sync-footnote">
        Branch server: {config.url || 'Not configured'}
      </p>
    </div>
  )
}
