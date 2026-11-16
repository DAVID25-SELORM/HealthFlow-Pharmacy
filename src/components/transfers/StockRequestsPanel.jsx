import { useMemo, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import {
  REQUEST_STATUS,
  REQUEST_STATUS_LABELS,
  requestNeedsMyAction,
  summarizeRequest,
} from '../../services/branchStockRequestService'
import { formatAppDateTime } from '../../utils/date'

const FILTERS = [
  { key: 'action', label: 'Needs my action' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Closed' },
  { key: 'all', label: 'All' },
]

export default function StockRequestsPanel({ requests, branchName, actor, error, canAsk, onOpen }) {
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')

  const counts = useMemo(() => ({
    action: requests.filter((row) => requestNeedsMyAction(actor, row)).length,
    waiting: requests.filter((row) => row.status === REQUEST_STATUS.PENDING).length,
    done: requests.filter((row) => row.status !== REQUEST_STATUS.PENDING).length,
    all: requests.length,
  }), [requests, actor])

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return requests.filter((row) => {
      if (filter === 'action' && !requestNeedsMyAction(actor, row)) return false
      if (filter === 'waiting' && row.status !== REQUEST_STATUS.PENDING) return false
      if (filter === 'done' && row.status === REQUEST_STATUS.PENDING) return false
      if (!term) return true
      return [row.request_number, branchName(row.requesting_branch_id), branchName(row.source_branch_id),
        ...(row.items || []).map((item) => item.medicine_name)].join(' ').toLowerCase().includes(term)
    })
  }, [requests, filter, query, actor, branchName])

  if (error) return <div className="stx-alert" role="alert">{error}</div>

  if (requests.length === 0) {
    return (
      <div className="stx-empty">
        <strong>No stock requests yet</strong>
        <span>
          {canAsk
            ? 'Use Request stock to ask the main store or another branch for medicines. They approve it and send the stock.'
            : 'When a branch asks for stock, the request appears here for you to approve or decline.'}
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="stx-toolbar">
        <div className="stx-filters" role="tablist" aria-label="Request status">
          {FILTERS.map((item) => (
            <button
              key={item.key} type="button" role="tab" aria-selected={filter === item.key}
              className={`stx-chip${filter === item.key ? ' is-active' : ''}`} onClick={() => setFilter(item.key)}
            >
              {item.label} <span>{counts[item.key]}</span>
            </button>
          ))}
        </div>
        <label className="stx-search stx-search--toolbar">
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder="Search number, branch or medicine" aria-label="Search requests" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>

      {visible.length === 0 ? (
        <div className="stx-empty"><strong>Nothing here</strong><span>No requests match this view.</span></div>
      ) : (
        <div className="stx-table-wrap">
          <table className="stx-table stx-list">
            <thead>
              <tr><th>Request</th><th>Asked</th><th className="num">Items</th><th>Status</th><th>Asked by</th><th aria-label="Open" /></tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const summary = summarizeRequest(row)
                const mine = requestNeedsMyAction(actor, row)
                return (
                  <tr key={row.id} className={mine ? 'stx-row-action' : ''}>
                    <td><strong>{row.request_number}</strong><span className="stx-sub">{formatAppDateTime(row.created_at)}</span></td>
                    <td className="stx-route">{branchName(row.requesting_branch_id)} <ArrowRight size={14} aria-label="asks" /> {branchName(row.source_branch_id)}</td>
                    <td className="num">{summary.lines} line{summary.lines === 1 ? '' : 's'}<span className="stx-sub">{summary.totalRequested} units</span></td>
                    <td>
                      <span className={`stx-badge stx-badge--${row.status}`}>{REQUEST_STATUS_LABELS[row.status] || row.status}</span>
                      {mine && <span className="stx-flag stx-flag--action">Decide</span>}
                    </td>
                    <td>{row.created_by_name || '—'}</td>
                    <td><button type="button" className="btn btn-outline btn-sm" onClick={() => onOpen(row.id)}>Open</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
