import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Gauge, RefreshCcw, Server } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  getProductionMetricsSnapshot,
  subscribeProductionMetrics,
} from '../services/productionMetricsService'
import { formatAppDateTime } from '../utils/date'
import './Diagnostics.css'

const formatMs = (value) => `${Math.round(Number(value) || 0)} ms`
const formatPercent = (value) => `${Math.round(Number(value) || 0)}%`

const MetricCard = ({ label, value, detail, icon: Icon = Gauge }) => (
  <article className="diagnostics-card">
    <div className="diagnostics-card-icon">
      <Icon size={20} />
    </div>
    <span>{label}</span>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </article>
)

export default function Diagnostics() {
  const { role } = useAuth()
  const [metrics, setMetrics] = useState(() => getProductionMetricsSnapshot())

  useEffect(() => subscribeProductionMetrics(setMetrics), [])

  const cacheTotals = useMemo(() => {
    const hits = metrics.cache.reduce((sum, item) => sum + item.hits, 0)
    const misses = metrics.cache.reduce((sum, item) => sum + item.misses, 0)
    const total = hits + misses
    return {
      hits,
      misses,
      hitRate: total ? Math.round((hits / total) * 100) : 0,
    }
  }, [metrics.cache])

  if (role !== 'super_admin') {
    return (
      <div className="diagnostics-page">
        <div className="diagnostics-alert">Only Super Admin can view production diagnostics.</div>
      </div>
    )
  }

  return (
    <div className="diagnostics-page">
      <div className="diagnostics-header">
        <div>
          <h1>Production Diagnostics</h1>
          <p>Live browser-side metrics for API latency, polling, failures, retries, and cache behavior.</p>
        </div>
        <button
          type="button"
          className="diagnostics-refresh"
          onClick={() => setMetrics(getProductionMetricsSnapshot())}
        >
          <RefreshCcw size={17} />
          Refresh
        </button>
      </div>

      <section className="diagnostics-grid">
        <MetricCard
          label="Average API Latency"
          value={formatMs(metrics.averageApiLatencyMs)}
          detail={`${metrics.totalRequests} tier-access request${metrics.totalRequests === 1 ? '' : 's'} started`}
          icon={Gauge}
        />
        <MetricCard
          label="Concurrent Requests"
          value={metrics.concurrentRequests}
          detail={`Peak ${metrics.maxConcurrentRequests}`}
          icon={Activity}
        />
        <MetricCard
          label="Cache Hit Rate"
          value={formatPercent(cacheTotals.hitRate)}
          detail={`${cacheTotals.hits} hit${cacheTotals.hits === 1 ? '' : 's'} / ${cacheTotals.misses} miss${cacheTotals.misses === 1 ? '' : 'es'}`}
          icon={Server}
        />
        <MetricCard
          label="Retry Count"
          value={metrics.retryCount}
          detail={`Since ${formatAppDateTime(metrics.startedAt)}`}
          icon={AlertTriangle}
        />
      </section>

      <section className="diagnostics-panel">
        <div className="diagnostics-panel-header">
          <h2>Current Polling Status</h2>
          <span className={`diagnostics-status ${metrics.polling.active ? 'active' : 'idle'}`}>
            {metrics.polling.active ? 'Active' : 'Idle'}
          </span>
        </div>
        <div className="diagnostics-polling-grid">
          <div>
            <span>Interval</span>
            <strong>{metrics.polling.intervalMs ? `${Math.round(metrics.polling.intervalMs / 1000)}s` : '-'}</strong>
          </div>
          <div>
            <span>Subscribers</span>
            <strong>{metrics.polling.subscriberCount}</strong>
          </div>
          <div>
            <span>Last Duration</span>
            <strong>{formatMs(metrics.polling.lastDurationMs)}</strong>
          </div>
          <div>
            <span>Last Status</span>
            <strong>{metrics.polling.lastStatus || 'idle'}</strong>
          </div>
        </div>
      </section>

      <section className="diagnostics-panel">
        <div className="diagnostics-panel-header">
          <h2>Slowest Tier-Access Actions</h2>
          <span>{metrics.slowestEndpoints.length} tracked</span>
        </div>
        <div className="diagnostics-table-wrap">
          <table className="diagnostics-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Average</th>
                <th>Slowest</th>
                <th>Last</th>
                <th>Calls</th>
                <th>Failures</th>
              </tr>
            </thead>
            <tbody>
              {metrics.slowestEndpoints.length ? metrics.slowestEndpoints.map((item) => (
                <tr key={item.action}>
                  <td>{item.action}</td>
                  <td>{formatMs(item.averageMs)}</td>
                  <td>{formatMs(item.maxMs)}</td>
                  <td>{formatMs(item.lastMs)}</td>
                  <td>{item.count}</td>
                  <td>{item.failures}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="6">No tier-access calls recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="diagnostics-columns">
        <div className="diagnostics-panel">
          <div className="diagnostics-panel-header">
            <h2>Cache Hit/Miss</h2>
          </div>
          <div className="diagnostics-list">
            {metrics.cache.length ? metrics.cache.map((item) => (
              <div key={item.name} className="diagnostics-list-row">
                <strong>{item.name}</strong>
                <span>{item.hits} hits / {item.misses} misses / {formatPercent(item.hitRate)}</span>
              </div>
            )) : <p>No cache events recorded yet.</p>}
          </div>
        </div>

        <div className="diagnostics-panel">
          <div className="diagnostics-panel-header">
            <h2>Failed Requests</h2>
          </div>
          <div className="diagnostics-list">
            {metrics.failedRequests.length ? metrics.failedRequests.map((item) => (
              <div key={`${item.action}-${item.at}`} className="diagnostics-list-row">
                <strong>{item.action}</strong>
                <span>{item.message} ({formatMs(item.durationMs)})</span>
              </div>
            )) : <p>No failed tier-access requests recorded.</p>}
          </div>
        </div>
      </section>
    </div>
  )
}
