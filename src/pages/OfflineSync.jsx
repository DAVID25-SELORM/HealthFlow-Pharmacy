import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, RefreshCcw, Server, UploadCloud } from 'lucide-react'
import {
  getBranchServerConfig,
  getBranchServerHealth,
  getBranchSyncStatus,
  pullBranchInventory,
  pullBranchReferenceData,
  runBranchSync,
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

export default function OfflineSync() {
  const { notify } = useNotification()
  const [config, setConfig] = useState(() => getBranchServerConfig())
  const [health, setHealth] = useState(null)
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')
  const [entityFilter, setEntityFilter] = useState('all')

  const refreshStatus = useCallback(async ({ silent = false } = {}) => {
    const nextConfig = getBranchServerConfig()
    setConfig(nextConfig)
    setError('')

    if (!nextConfig.enabled || !nextConfig.token) {
      setHealth(null)
      setStatus(null)
      setLoading(false)
      setError('Local branch server is not configured in this browser.')
      return
    }

    try {
      setLoading(true)
      const [nextHealth, nextStatus] = await Promise.all([
        getBranchServerHealth(),
        getBranchSyncStatus(),
      ])
      setHealth(nextHealth)
      setStatus(nextStatus)
      if (!silent) {
        notify('Offline sync status refreshed.', 'success')
      }
    } catch (statusError) {
      setHealth(null)
      setStatus(null)
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
