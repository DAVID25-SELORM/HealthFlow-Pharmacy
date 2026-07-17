import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Gauge, RefreshCcw, Server } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { DataTable, EmptyState, PageHeader, StatCard, StatusBadge, Toolbar } from '../components/ui'
import {
  getProductionMetricsSnapshot,
  subscribeProductionMetrics,
} from '../services/productionMetricsService'
import { formatAppDateTime } from '../utils/date'
import './Diagnostics.css'

const formatMs = (value) => `${Math.round(Number(value) || 0)} ms`
const formatPercent = (value) => `${Math.round(Number(value) || 0)}%`

const MetricCard = ({ label, value, detail, icon: Icon = Gauge }) => (
  <StatCard
    className="diagnostics-card"
    label={label}
    value={value}
    meta={detail}
  >
    <div className="diagnostics-card-icon">
      <Icon size={20} />
    </div>
  </StatCard>
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
        <EmptyState
          title="Super Admin access required"
          description="Only Super Admin can view production diagnostics."
        />
      </div>
    )
  }

  const historyColumns = [
    { key: 'label', header: 'Window' },
    { key: 'averageApiLatencyMs', header: 'Avg Latency', render: (item) => formatMs(item.averageApiLatencyMs) },
    { key: 'peakConcurrentRequests', header: 'Peak Concurrency' },
    { key: 'retryCountDelta', header: 'Retry Delta' },
    { key: 'averageCacheHitRate', header: 'Avg Cache Hit', render: (item) => formatPercent(item.averageCacheHitRate) },
    { key: 'failedRequestPeak', header: 'Failed Request Peak' },
    { key: 'pollingAverageMs', header: 'Avg Polling Time', render: (item) => formatMs(item.pollingAverageMs) },
  ]

  const endpointColumns = [
    { key: 'action', header: 'Action' },
    { key: 'averageMs', header: 'Average', render: (item) => formatMs(item.averageMs) },
    { key: 'maxMs', header: 'Slowest', render: (item) => formatMs(item.maxMs) },
    { key: 'lastMs', header: 'Last', render: (item) => formatMs(item.lastMs) },
    { key: 'count', header: 'Calls' },
    { key: 'failures', header: 'Failures' },
  ]

  return (
    <div className="diagnostics-page">
      <PageHeader
        eyebrow="Super Admin"
        title="Production Diagnostics"
        description="Live browser-side metrics for API latency, polling, failures, retries, and cache behavior."
        actions={(
          <button
            type="button"
            className="diagnostics-refresh"
            onClick={() => setMetrics(getProductionMetricsSnapshot())}
          >
            <RefreshCcw size={17} />
            Refresh
          </button>
        )}
      />

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

      {metrics.activeAlerts.length > 0 && (
        <section className="diagnostics-panel diagnostics-alert-panel">
          <Toolbar
            className="diagnostics-panel-toolbar"
            title="Active Monitoring Alerts"
            actions={<StatusBadge tone="danger">{metrics.activeAlerts.length} active</StatusBadge>}
          />
          <div className="diagnostics-list">
            {metrics.activeAlerts.map((alert) => (
              <div key={alert.id} className="diagnostics-list-row">
                <strong>{alert.title}</strong>
                <span>{alert.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="diagnostics-section">
        <Toolbar
          className="diagnostics-panel-toolbar"
          title="Rolling History"
          description={`${metrics.history.samples.length} sample${metrics.history.samples.length === 1 ? '' : 's'}`}
        />
        <DataTable
          columns={historyColumns}
          rows={metrics.history.windows}
          getRowKey={(item) => item.label}
          emptyState={<EmptyState title="No history yet" description="Diagnostics history will appear after metrics are sampled." />}
          minWidth="820px"
        />
      </section>

      <section className="diagnostics-section">
        <Toolbar
          className="diagnostics-panel-toolbar"
          title="Current Polling Status"
          actions={(
            <StatusBadge tone={metrics.polling.active ? 'success' : 'neutral'}>
              {metrics.polling.active ? 'Active' : 'Idle'}
            </StatusBadge>
          )}
        />
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

      <section className="diagnostics-section">
        <Toolbar
          className="diagnostics-panel-toolbar"
          title="Slowest Tier-Access Actions"
          description={`${metrics.slowestEndpoints.length} tracked`}
        />
        <DataTable
          columns={endpointColumns}
          rows={metrics.slowestEndpoints}
          getRowKey={(item) => item.action}
          emptyState={<EmptyState title="No tier-access calls recorded yet" description="Tracked action timings will appear after requests run." />}
          minWidth="760px"
        />
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
