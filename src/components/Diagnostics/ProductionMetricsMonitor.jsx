import { useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useNotification } from '../../context/NotificationContext'
import {
  evaluateProductionMetricAlerts,
  filterNewProductionMetricAlerts,
  recordProductionMetricsSample,
} from '../../services/productionMetricsService'

const SAMPLE_INTERVAL_MS = 60 * 1000

export default function ProductionMetricsMonitor() {
  const { role } = useAuth()
  const { notify } = useNotification()
  const isSuperAdmin = role === 'super_admin'

  useEffect(() => {
    if (!isSuperAdmin) return undefined

    const runMonitor = () => {
      recordProductionMetricsSample()
      const alerts = filterNewProductionMetricAlerts(evaluateProductionMetricAlerts())
      alerts.forEach((alert) => {
        notify(`${alert.title}: ${alert.detail}`, alert.severity || 'warning', 0)
      })
    }

    runMonitor()
    const interval = window.setInterval(runMonitor, SAMPLE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [isSuperAdmin, notify])

  return null
}
