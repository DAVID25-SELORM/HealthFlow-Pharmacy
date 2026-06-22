import { useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { invokeTierAccess } from '../services/tierAccessService'
import './ActivityLog.css'

const ACTIVITY_LOG_TIMEZONE = 'Africa/Accra'
const activityLogDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false,
  timeZone: ACTIVITY_LOG_TIMEZONE,
})

const formatTimestamp = (value) => {
  if (!value) {
    return '-'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }

  return activityLogDateTimeFormatter.format(date)
}

const humanizeKey = (value) =>
  String(value || '')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())

const formatDetailValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return ''
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatDetailValue(item)).filter(Boolean).join(', ')
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

const formatDetails = (details) => {
  if (!details || typeof details !== 'object') {
    return ''
  }

  const detailText = Object.entries(details)
    .map(([key, value]) => {
      const formattedValue = formatDetailValue(value)
      if (!formattedValue) {
        return ''
      }

      return `${humanizeKey(key)}: ${formattedValue}`
    })
    .filter(Boolean)
    .join(' | ')

  return detailText || ''
}

const getLogActor = (log) => {
  const detailActorEmail = formatDetailValue(log.details?.actor_email)
  const detailEmail = formatDetailValue(log.details?.email)
  const detailActorUserId = formatDetailValue(log.details?.actor_user_id)

  return (
    log.actor_email ||
    detailActorEmail ||
    detailEmail ||
    log.actor_user_id ||
    detailActorUserId ||
    'Unknown'
  )
}

const toSearchBlob = (log) => {
  const details = formatDetails(log.details)

  return [
    getLogActor(log),
    log.event_type,
    log.entity_type,
    log.action,
    details,
    log.created_at,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export default function ActivityLog() {
  const [logs, setLogs] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let isMounted = true

    async function fetchLogs() {
      if (!isMounted) {
        return
      }

      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setLogs([])
        setError('Supabase is not configured. Update .env to enable activity logs.')
        setLoading(false)
        return
      }

      let data = []
      let fetchError = null

      try {
        const result = await invokeTierAccess({ action: 'get_activity_logs', limit: 200 })
        data = Array.isArray(result?.logs) ? result.logs : []
      } catch (error) {
        fetchError = error

        const isUnsupportedAction = String(error?.message || '').toLowerCase().includes('unsupported action')
        if (isUnsupportedAction) {
          const fallbackResult = await supabase
            .from('audit_logs')
            .select('id, actor_user_id, actor_email, event_type, entity_type, action, details, created_at')
            .order('created_at', { ascending: false })
            .limit(200)

          data = fallbackResult.data
          fetchError = fallbackResult.error
        }
      }

      if (!isMounted) {
        return
      }

      if (fetchError) {
        const message = String(fetchError.message || '').toLowerCase()
        const hasPermissionIssue = fetchError.code === '42501' || message.includes('permission')

        setLogs([])
        setError(
          hasPermissionIssue
            ? 'You do not have permission to view activity logs.'
            : 'Failed to load activity logs.'
        )
        setLoading(false)
        return
      }

      setLogs(Array.isArray(data) ? data : [])
      setLoading(false)
    }

    void fetchLogs()

    return () => {
      isMounted = false
    }
  }, [])

  const filteredLogs = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    if (!query) {
      return logs
    }

    return logs.filter((log) => toSearchBlob(log).includes(query))
  }, [logs, searchTerm])

  if (loading) return <div className="activity-log">Loading activity logs...</div>
  if (error) return <div className="activity-log error">{error}</div>

  return (
    <div className="activity-log">
      <div className="activity-log-header">
        <h2>Activity Log</h2>
        <input
          type="search"
          className="activity-log-search"
          placeholder="Search logs..."
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          aria-label="Search activity logs"
        />
      </div>

      <p className="activity-log-meta">
        Showing {filteredLogs.length} of {logs.length} record{logs.length === 1 ? '' : 's'}.
      </p>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Event</th>
            <th>Entity</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {filteredLogs.length === 0 ? (
            <tr>
              <td className="activity-log-empty" colSpan={6}>
                No activity records matched your search.
              </td>
            </tr>
          ) : (
            filteredLogs.map((log) => {
              const details = formatDetails(log.details)
              return (
                <tr key={log.id}>
                  <td>{formatTimestamp(log.created_at)}</td>
                  <td>{getLogActor(log)}</td>
                  <td>{log.event_type || '-'}</td>
                  <td>{log.entity_type || '-'}</td>
                  <td>{log.action || '-'}</td>
                  <td className="activity-log-details" title={details}>
                    {details || '-'}
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
