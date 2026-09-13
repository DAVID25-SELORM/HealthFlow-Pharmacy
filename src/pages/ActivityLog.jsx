import { useEffect, useRef, useState } from 'react'
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

const humanizeKey = (value) => String(value || '').replace(/_/g, ' ').trim().replace(/\b\w/g, (char) => char.toUpperCase()).replace(/\bNhis\b/g, 'NHIS')

const getLogActor = (log) => log.actor_name || log.actor_email || 'Historical staff member'
const MONTHS = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, index, 1))))
const getSubjectFields = (log) => Object.entries(log.subject?.fields || {}).filter(([, value]) => typeof value === 'string' && value.trim())
const getSubjectFallback = (log) => log.subject?.restricted ? 'Record details restricted' : 'Record details unavailable'
const getSafeDetails = (log) => ['status', 'reason', 'previous_status', 'new_status']
  .filter((key) => typeof log.details?.[key] === 'string' && log.details[key])
  .map((key) => [humanizeKey(key), log.details[key]])

const getActorOptionLabel = (actor) => {
  const name = String(actor?.full_name || '').trim()
  const email = String(actor?.email || '').trim()
  const identity = name || email || 'Historical staff member'
  return `${identity}${name && email ? ` (${email})` : ''}${actor?.is_active === false ? ' — inactive' : ''}`
}

export default function ActivityLog() {
  const { organization, loading: authLoading } = useAuth()
  const organizationId = organization?.id || ''
  const [logs, setLogs] = useState([])
  const [actors, setActors] = useState([])
  const [eventTypes, setEventTypes] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [actorUserId, setActorUserId] = useState('')
  const [eventType, setEventType] = useState('')
  const [period, setPeriod] = useState('all')
  const [year, setYear] = useState(new Date().getUTCFullYear())
  const [month, setMonth] = useState('')
  const [officerSearch, setOfficerSearch] = useState('')
  const [selectedLog, setSelectedLog] = useState(null)
  const dialogRef = useRef(null)
  useEffect(() => {
    if (selectedLog) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [selectedLog])
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
      // Wait for AuthContext to resolve the current user before requesting
      // their tenant-scoped audit trail.
      if (authLoading) return
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
          period, year: Number(year), month: month || null,
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
  }, [actorUserId, authLoading, eventType, fromDate, organizationId, page, searchTerm, toDate, period, year, month])

  const hasNextPage = page * ACTIVITY_LOG_PAGE_SIZE < total
  const showingFrom = logs.length === 0 ? 0 : (page - 1) * ACTIVITY_LOG_PAGE_SIZE + 1
  const showingTo = logs.length === 0 ? 0 : showingFrom + logs.length - 1
  const selectedActor = actors.find((actor) => actor.id === actorUserId)
  const activityCountLabel = actorUserId
    ? `Activities by ${selectedActor?.full_name || selectedActor?.email || 'selected claims officer'}`
    : 'Activities by all claims officers'
  const numberedLogs = logs.map((log, index) => ({ ...log, activityNumber: (page - 1) * ACTIVITY_LOG_PAGE_SIZE + index + 1 }))

  const selectClaimsOfficer = (value) => {
    // Use the immutable user ID as the option value. A name-only datalist can
    // look selected while failing to resolve, silently disabling the filter.
    setActorUserId(value)
    setPage(1)
  }

  const columns = [
    { key: 'activityNumber', header: 'No.', render: (log) => log.activityNumber },
    { key: 'created_at', header: 'Time', render: (log) => formatTimestamp(log.created_at) },
    { key: 'actor', header: 'User', render: (log) => <div>{getLogActor(log)}<small className="activity-log-role">{humanizeKey(log.details?.active_role)}</small></div> },
    { key: 'event_type', header: 'Event', render: (log) => humanizeKey(log.event_type) || '-' },
    { key: 'action', header: 'Action', render: (log) => humanizeKey(log.action).replaceAll('.', ' / ') || '-' },
    {
      key: 'subject', header: 'Affected record', render: (log) => (
        <div className="activity-log-subject">
          {getSubjectFields(log).length ? getSubjectFields(log).map(([label, value]) => <div key={label}><strong>{label}:</strong> {value}</div>) : getSubjectFallback(log)}
          {log.subject?.source === 'current' && <small>Current record details</small>}
          {log.subject?.source === 'snapshot_or_current' && <small>Recorded details with current references where needed</small>}
        </div>
      ),
    },
    { key: 'details', header: 'Details', render: (log) => <button type="button" className="btn btn-outline" onClick={() => setSelectedLog(log)}>View Details</button> },
  ]


  return (
    <div className="activity-log">
      {error && <div className="error" role="alert">{error}</div>}
      <PageHeader eyebrow="Administration" title="Activity Log" description="Review recent system actions, user activity, and operational audit events." />
      <Toolbar title="Audit records" description={loading ? 'Loading matching records...' : `Showing records ${showingFrom}-${showingTo} of ${total}. Matching the selected filters.`}>
        <div className="activity-log-filters">
          <label><span>Date period</span><select value={period} onChange={(event) => { setPeriod(event.target.value); setFromDate(''); setToDate(''); setPage(1) }}>
            <option value="all">All dates</option><option value="current_month">Current month</option><option value="previous_month">Previous month</option><option value="today">Today</option><option value="month">Select Month</option><option value="custom">Custom range</option>
          </select></label>
          {period === 'month' && <>
            <label><span>Year</span><input type="number" min="1900" max="9998" value={year} onChange={(event) => { setYear(event.target.value); setPage(1) }} /></label>
            <label><span>Month</span><select value={month} onChange={(event) => { setMonth(event.target.value); setPage(1) }}><option value="">All Months</option>{MONTHS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label>
          </>}
          <label><span>From</span><input type="date" value={period === 'custom' ? fromDate : ''} max={toDate || undefined} onChange={(event) => { setPeriod('custom'); setFromDate(event.target.value); setPage(1) }} /></label>
          <label><span>To</span><input type="date" value={period === 'custom' ? toDate : ''} min={fromDate || undefined} onChange={(event) => { setPeriod('custom'); setToDate(event.target.value); setPage(1) }} /></label>
          <label><span>Find officer</span><input type="search" value={officerSearch} onChange={(event) => setOfficerSearch(event.target.value)} placeholder="Staff name or email" /></label>
          <label>
            <span>Claims officer</span>
            <select value={actorUserId} onChange={(event) => selectClaimsOfficer(event.target.value)} aria-label="Claims officer">
              <option value="">All claims officers</option>
              {actors.filter((actor) => actor.id === actorUserId || getActorOptionLabel(actor).toLowerCase().includes(officerSearch.toLowerCase())).map((actor) => <option key={actor.id} value={actor.id}>{getActorOptionLabel(actor)}</option>)}
            </select>
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
      <div className="activity-log-count" role="status" aria-label="Matching activity count" aria-live="polite" aria-busy={loading}>
        <span>{activityCountLabel}{period === 'month' ? ` - ${month ? MONTHS[Number(month) - 1] : 'All months'} ${year}` : ''}</span>
        <strong>{loading ? 'Loading...' : total.toLocaleString('en-GB')}</strong>
        <small>Logged activities matching the selected dates, activity type and search. Multiple actions on one claim count separately.</small>
      </div>
      <DataTable columns={columns} rows={numberedLogs} getRowKey={(log) => log.id} loading={loading} loadingState={<LoadingState title="Loading activity logs" description="Applying filters to audit records..." />} emptyState={<EmptyState title="No activity records found" description="Try adjusting the date range or filters." />} minWidth="980px" />
      <dialog ref={dialogRef} className="activity-log-dialog" onCancel={() => setSelectedLog(null)} onClose={() => setSelectedLog(null)} aria-labelledby="activity-detail-title">
        {selectedLog && <>
          <header><h2 id="activity-detail-title">Activity details</h2><button type="button" className="btn btn-outline" onClick={() => setSelectedLog(null)}>Close</button></header>
          <dl>
            {[
              ['Actor', getLogActor(selectedLog)], ['Role', humanizeKey(selectedLog.details?.active_role) || 'Not recorded'],
              ['Activity', humanizeKey(selectedLog.event_type)], ['Action', humanizeKey(selectedLog.action).replaceAll('.', ' / ')],
              ['Date / time (Ghana)', formatTimestamp(selectedLog.created_at)],
              ...(getSubjectFields(selectedLog).length ? getSubjectFields(selectedLog) : [['Affected record', getSubjectFallback(selectedLog)]]),
              ...getSafeDetails(selectedLog),
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <p>{['current', 'snapshot_or_current'].includes(selectedLog.subject?.source) ? 'Recorded identifiers are preferred; missing identifiers use current record details.' : 'Only recorded, permitted details are shown. Older events may lack record information.'}</p>
        </>}
      </dialog>
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
