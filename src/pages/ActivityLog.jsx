import { useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { invokeTierAccess } from '../services/tierAccessService'
import { useAuth } from '../context/AuthContext'
import { DataTable, EmptyState, LoadingState, PageHeader, Toolbar } from '../components/ui'
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
  const { organization } = useAuth()
  const organizationId = organization?.id || ''
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
        setError('HealthFlow Cloud is not configured. Update .env to enable activity logs.')
        setLoading(false)
        return
      }

      let data = []
      let fetchError = null

      if (organizationId) {
        // Facility activity is already protected by audit_logs RLS. Reading it
        // directly avoids an unnecessary Edge Function hop and keeps this page
        // available even when the shared function is busy serving larger jobs.
        const result = await supabase
          .from('audit_logs')
          .select('id, actor_user_id, actor_email, event_type, entity_type, action, details, created_at')
          .eq('organization_id', organizationId)
          .order('created_at', { ascending: false })
          .limit(200)

        data = result.data
        fetchError = result.error
      } else {
        try {
          const result = await invokeTierAccess({ action: 'get_activity_logs', limit: 200 })
          data = Array.isArray(result?.logs) ? result.logs : []
        } catch (error) {
          fetchError = error
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
  }, [organizationId])

  const filteredLogs = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    if (!query) {
      return logs
    }

    return logs.filter((log) => toSearchBlob(log).includes(query))
  }, [logs, searchTerm])

  const columns = [
    {
      key: 'created_at',
      header: 'Time',
      render: (log) => formatTimestamp(log.created_at),
    },
    {
      key: 'actor',
      header: 'User',
      render: (log) => getLogActor(log),
    },
    {
      key: 'event_type',
      header: 'Event',
      render: (log) => log.event_type || '-',
    },
    {
      key: 'entity_type',
      header: 'Entity',
      render: (log) => log.entity_type || '-',
    },
    {
      key: 'action',
      header: 'Action',
      render: (log) => log.action || '-',
    },
    {
      key: 'details',
      header: 'Details',
      render: (log) => {
        const details = formatDetails(log.details)
        return (
          <span className="activity-log-details" title={details}>
            {details || '-'}
          </span>
        )
      },
    },
  ]

  if (error) return <div className="activity-log error">{error}</div>

  return (
    <div className="activity-log">
      <PageHeader
        eyebrow="Administration"
        title="Activity Log"
        description="Review recent system actions, user activity, and operational audit events."
      />

      <Toolbar
        title="Audit records"
        description={`Showing ${filteredLogs.length} of ${logs.length} record${logs.length === 1 ? '' : 's'}.`}
      >
        <input
          type="search"
          className="activity-log-search"
          placeholder="Search logs..."
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          aria-label="Search activity logs"
        />
      </Toolbar>

      <DataTable
        columns={columns}
        rows={filteredLogs}
        getRowKey={(log) => log.id}
        loading={loading}
        loadingState={<LoadingState title="Loading activity logs" description="Fetching recent audit events..." />}
        emptyState={<EmptyState title="No activity records found" description="Try adjusting your search term." />}
        minWidth="980px"
      />
    </div>
  )
}
