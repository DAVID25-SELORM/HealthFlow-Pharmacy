import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, RefreshCcw, XCircle } from 'lucide-react'
import { getSystemHealth } from '../services/systemHealthService'
import { useAuth } from '../context/AuthContext'
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
  const { canViewReports } = useAuth()
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadHealth = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      setHealth(await getSystemHealth({ canViewReports }))
    } catch (loadError) {
      setHealth(null)
      setError(loadError.message || 'Unable to load system health.')
    } finally {
      setLoading(false)
    }
  }, [canViewReports])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  const overall = getStatusMeta(health?.status)
  const OverallIcon = overall.icon

  return (
    <div className="system-health-page">
      <div className="system-health-header">
        <div>
          <h1>System Health</h1>
          <p>Production checks for login, database access, sales, NHIS, reports, activity logs, and local branch connectivity.</p>
        </div>
        <button className="system-health-refresh" type="button" onClick={() => void loadHealth()} disabled={loading}>
          <RefreshCcw size={17} />
          {loading ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="system-health-alert">{error}</div>}

      <section className={`system-health-overall status-${health?.status || 'warn'}`}>
        <div className="system-health-overall-icon">
          {loading ? <Activity size={26} /> : <OverallIcon size={26} />}
        </div>
        <div>
          <span>Overall status</span>
          <strong>{loading ? 'Checking' : overall.label}</strong>
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
        <div className="system-health-empty">No health checks returned.</div>
      )}
    </div>
  )
}
