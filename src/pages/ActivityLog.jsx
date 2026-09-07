import { useEffect, useMemo, useState } from 'react'
import { isSupabaseConfigured } from '../lib/supabase'
import { invokeTierAccess } from '../services/tierAccessService'
import { useAuth } from '../context/AuthContext'
import { DataTable, EmptyState, LoadingState, PageHeader, Toolbar } from '../components/ui'
import './ActivityLog.css'

const ACTIVITY_LOG_TIMEZONE = 'Africa/Accra'
const ACTIVITY_LOG_PAGE_SIZE = 100
const activityLogDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'medium', hour12: false, timeZone: ACTIVITY_LOG_TIMEZONE,
})

const formatTimestamp = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : activityLogDateTimeFormatter.format(date)
}

const humanizeKey = (value) => String(value || '').replace(/_/g, ' ').trim().replace(/\b\w/g, (char) => char.toUpperCase())

const formatDetailValue = (value) => {
  if (value === null || value === undefined || value === '') return ''
  if (Array.isArray(value)) return value.map(formatDetailValue).filter(Boolean).join(', ')
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const formatDetails = (details) => {
  if (!details || typeof details !== 'object') return ''
  return Object.entries(details)
    .map(([key, value]) => {
      const formattedValue = formatDetailValue(value)
      return formattedValue ? `${humanizeKey(key)}: ${formattedValue}` : ''
    })
    .filter(Boolean)
    .join(' | ')
}

const getLogActor = (log) => (
  log.actor_name ||
  log.actor_email ||
  formatDetailValue(log.details?.actor_email) ||
  formatDetailValue(log.details?.email) ||
  log.actor_user_id ||
  formatDetailValue(log.details?.actor_user_id) ||
  'Unknown'
)

const getActorOptionLabel = (actor) => {
  const name = String(actor?.full_name || '').trim()
  const email = String(actor?.email || '').trim()
  const identity = name || email || 'Historical staff member'
  return `${identity}${name && email ? ` (${email})` : ''}${actor?.is_active === false ? ' — inactive' : ''}`
}

export default function ActivityLog() {
  const { organization } = useAuth()
  const organizationId = organization?.id || ''
  const [logs, setLogs] = useState([])
  const [actors, setActors] = useState([])
  const [eventTypes, setEventTypes] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [claimsOfficerTerm, setClaimsOfficerTerm] = useState('')
  const [actorUserId, setActorUserId] = useState('')
  const [eventType, setEventType] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let isMounted = true

    async function fetchLogs() {
      if (!isMounted) return
      setLoading(true)
      setError('')

      if (!isSupabaseConfigured()) {
        setLogs([])
        setTotal(0)
        setError('HealthFlow Cloud is not configured. Update .env to enable activity logs.')
        setLoading(false)
        return
      }

      try {
        const result = await invokeTierAccess({
          action: 'get_activity_logs',
          page,
          pageSize: ACTIVITY_LOG_PAGE_SIZE,
          fromDate: fromDate || null,
          toDate: toDate || null,
          actorUserId: actorUserId || null,
          eventType: eventType || null,
          search: searchTerm.trim() || null,
        })
        if (!isMounted) return
        setLogs(Array.isArray(result?.logs) ? result.logs : [])
        setTotal(Number(result?.total || 0))
        setActors(Array.isArray(result?.actors) ? result.actors : [])
        setEventTypes(Array.isArray(result?.eventTypes) ? result.eventTypes : [])
      } catch (fetchError) {
        if (!isMounted) return
        const message = String(fetchError?.message || '').toLowerCase()
        setLogs([])
        setTotal(0)
        setError(message.includes('permission') ? 'You do not have permission to view activity logs.' : 'Failed to load activity logs.')
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    void fetchLogs()
    return () => { isMounted = false }
  }, [actorUserId, eventType, fromDate, organizationId, page, searchTerm, toDate])

  const actorLabels = useMemo(() => new Map(actors.map((actor) => [getActorOptionLabel(actor), actor.id])), [actors])
  const hasNextPage = page * ACTIVITY_LOG_PAGE_SIZE < total
  const showingFrom = logs.length === 0 ? 0 : (page - 1) * ACTIVITY_LOG_PAGE_SIZE + 1
  const showingTo = logs.length === 0 ? 0 : showingFrom + logs.length - 1

  const selectClaimsOfficer = (value) => {
    setClaimsOfficerTerm(value)
    setActorUserId(actorLabels.get(value) || '')
    setPage(1)
  }

  const columns = [
    { key: 'created_at', header: 'Time', render: (log) => formatTimestamp(log.created_at) },
    { key: 'actor', header: 'User', render: (log) => getLogActor(log) },
    { key: 'event_type', header: 'Event', render: (log) => log.event_type || '-' },
    { key: 'entity_type', header: 'Entity', render: (log) => log.entity_type || '-' },
    { key: 'action', header: 'Action', render: (log) => log.action || '-' },
    {
      key: 'details', header: 'Details', render: (log) => {
        const details = formatDetails(log.details)
        return <span className="activity-log-details" title={details}>{details || '-'}</span>
      },
    },
  ]

  if (error) return <div className="activity-log error">{error}</div>

  return (
    <div className="activity-log">
      <PageHeader eyebrow="Administration" title="Activity Log" description="Review recent system actions, user activity, and operational audit events." />
      <Toolbar title="Audit records" description={`Showing records ${showingFrom}-${showingTo} of ${total}. All active filters are applied before pagination.`}>
        <div className="activity-log-filters">
          <label><span>From</span><input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => { setFromDate(event.target.value); setPage(1) }} /></label>
          <label><span>To</span><input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => { setToDate(event.target.value); setPage(1) }} /></label>
          <label>
            <span>Claims officer</span>
            <input type="search" list="activity-log-claims-officers" value={claimsOfficerTerm} placeholder="Search staff..." onChange={(event) => selectClaimsOfficer(event.target.value)} aria-label="Claims officer" />
            <datalist id="activity-log-claims-officers">
              {actors.map((actor) => <option key={actor.id} value={getActorOptionLabel(actor)} />)}
            </datalist>
          </label>
          <label>
            <span>Activity type</span>
            <select value={eventType} onChange={(event) => { setEventType(event.target.value); setPage(1) }} aria-label="Activity type">
              <option value="">All activity types</option>
              {eventTypes.map((type) => <option key={type} value={type}>{humanizeKey(type)}</option>)}
            </select>
          </label>
          <input type="search" className="activity-log-search" placeholder="Search all matching records..." value={searchTerm} onChange={(event) => { setSearchTerm(event.target.value); setPage(1) }} aria-label="Search activity logs" />
        </div>
      </Toolbar>
      <DataTable columns={columns} rows={logs} getRowKey={(log) => log.id} loading={loading} loadingState={<LoadingState title="Loading activity logs" description="Applying filters to audit records..." />} emptyState={<EmptyState title="No activity records found" description="Try adjusting the date range or filters." />} minWidth="980px" />
      <div className="activity-log-pagination">
        <span>Page {page}</span>
        <div>
          <button type="button" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
          <button type="button" disabled={loading || !hasNextPage} onClick={() => setPage((current) => current + 1)}>Next</button>
        </div>
      </div>
    </div>
  )
}
