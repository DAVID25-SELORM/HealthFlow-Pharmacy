import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, RefreshCcw, XCircle } from 'lucide-react'
import { getSystemHealth } from '../services/systemHealthService'
import { useAuth } from '../context/AuthContext'
import { EmptyState, PageHeader, StatusBadge } from '../components/ui'
import { formatAppDateTime } from '../utils/date'
import './SystemHealth.css'

const statusMeta = {
  ok: {
    label: 'Healthy',
    icon: CheckCircle2,
  },
  warn: {
    label: 'Review',
    icon: AlertTriangle,
  },
  fail: {
    label: 'Issue',
    icon: XCircle,
  },
}

const getStatusMeta = (status) => statusMeta[status] || statusMeta.warn

export default function SystemHealth() {
  const { canViewReports, loading: authLoading, role } = useAuth()
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const abortRef = useRef(null)

  const loadHealth = useCallback(async () => {
    if (authLoading || !role) {
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      setLoading(true)
      setError('')
      setHealth(await getSystemHealth({
        canViewReports,
        activeRole: role,
        force: true,
        scope: 'full',
        signal: controller.signal,
      }))
    } catch (loadError) {
      if (controller.signal.aborted) {
        return
      }
      setHealth(null)
      setError(loadError.message || 'Unable to load system health.')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [authLoading, canViewReports, role])

  useEffect(() => {
    void loadHealth()
    return () => {
      abortRef.current?.abort()
    }
  }, [loadHealth])

  const overall = getStatusMeta(health?.status)
  const OverallIcon = overall.icon

  return (
    <div className="system-health-page">
      <PageHeader
        eyebrow="Operations"
        title="System Health"
        description="Production checks for login, database access, sales, NHIS, reports, activity logs, and local branch connectivity."
        actions={(
          <button className="system-health-refresh" type="button" onClick={() => void loadHealth()} disabled={loading}>
            <RefreshCcw size={17} />
            {loading ? 'Checking...' : 'Refresh'}
          </button>
        )}
      />

      {error && <div className="system-health-alert">{error}</div>}

      <section className={`system-health-overall status-${health?.status || 'warn'}`}>
        <div className="system-health-overall-icon">
          {loading ? <Activity size={26} /> : <OverallIcon size={26} />}
        </div>
        <div>
          <span>Overall status</span>
          <strong>
            {loading ? 'Checking' : (
              <StatusBadge tone={health?.status === 'ok' ? 'success' : health?.status === 'fail' ? 'danger' : 'warning'}>
                {overall.label}
              </StatusBadge>
            )}
          </strong>
          <small>
            {health?.checkedAt ? `Last checked ${formatAppDateTime(health.checkedAt)}` : 'Waiting for first check'}
          </small>
        </div>
      </section>

      <div className="system-health-grid">
        {(health?.checks || []).map((check) => {
          const meta = getStatusMeta(check.status)
          const Icon = meta.icon
          return (
            <article className={`system-health-card status-${check.status}`} key={check.label}>
              <div className="system-health-card-header">
                <Icon size={20} />
                <span>{meta.label}</span>
              </div>
              <h2>{check.label}</h2>
              <strong>{check.summary}</strong>
              {check.detail && <p>{check.detail}</p>}
              {check.timestamp && <small>{formatAppDateTime(check.timestamp)}</small>}
            </article>
          )
        })}
      </div>

      {!loading && !health?.checks?.length && !error && (
        <EmptyState
          title="No health checks returned"
          description="Refresh the page to run the operational checks again."
        />
      )}
    </div>
  )
}
