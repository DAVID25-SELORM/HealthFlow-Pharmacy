import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, ArrowRightLeft, Plus, RefreshCcw, Search } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { useTenant } from '../context/TenantContext'
import { getBranches } from '../services/branchService'
import {
  TRANSFER_STATUS,
  TRANSFER_STATUS_LABELS,
  canSendFromBranch,
  describeActor,
  listBranchTransfers,
  needsMyAction,
  summarizeTransfer,
} from '../services/branchTransferService'
import { dispatchHealthflowDataChanged } from '../lib/appEvents'
import { formatAppDateTime } from '../utils/date'
import NewTransferModal from '../components/transfers/NewTransferModal'
import TransferDetailModal from '../components/transfers/TransferDetailModal'
import AddBranchModal from '../components/transfers/AddBranchModal'
import './StockTransfers.css'

const FILTERS = [
  { key: 'action', label: 'Needs my action' },
  { key: 'transit', label: 'In transit' },
  { key: 'done', label: 'Completed' },
  { key: 'all', label: 'All' },
]

function StockTransfers() {
  const { role, assignedRoles, profile } = useAuth()
  const { organization, canUseMultiBranch } = useTenant()
  const { notify } = useNotification()
  const actor = useMemo(() => describeActor({ role, assignedRoles, profile }), [role, assignedRoles, profile])

  const [transfers, setTransfers] = useState([])
  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showAddBranch, setShowAddBranch] = useState(false)
  const [openId, setOpenId] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [transferRows, branchRows] = await Promise.all([listBranchTransfers(), getBranches()])
      setTransfers(transferRows)
      setBranches(branchRows)
    } catch (loadError) {
      setError(loadError.message || 'Unable to load stock transfers.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const branchName = useCallback(
    (id) => branches.find((row) => row.id === id)?.name || 'Unknown branch',
    [branches]
  )
  const activeBranches = branches.filter((row) => row.is_active !== false)
  const canStartTransfer = activeBranches.some((row) => canSendFromBranch(actor, row.id)) && activeBranches.length >= 2
  const mayAddBranch = actor.isAdmin || actor.isManager
  const branchesLocked = !canUseMultiBranch && activeBranches.length >= 1

  const counts = useMemo(() => ({
    action: transfers.filter((row) => needsMyAction(actor, row)).length,
    transit: transfers.filter((row) => row.status === TRANSFER_STATUS.PENDING).length,
    done: transfers.filter((row) => row.status !== TRANSFER_STATUS.PENDING).length,
    all: transfers.length,
  }), [transfers, actor])

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return transfers.filter((row) => {
      if (filter === 'action' && !needsMyAction(actor, row)) return false
      if (filter === 'transit' && row.status !== TRANSFER_STATUS.PENDING) return false
      if (filter === 'done' && row.status === TRANSFER_STATUS.PENDING) return false
      if (!term) return true
      return [row.transfer_number, branchName(row.source_branch_id), branchName(row.destination_branch_id),
        ...(row.items || []).map((item) => item.medicine_name)].join(' ').toLowerCase().includes(term)
    })
  }, [transfers, filter, query, actor, branchName])

  const opened = transfers.find((row) => row.id === openId) || null
  const facility = {
    name: organization?.name, address: organization?.address, city: organization?.city,
    region: organization?.region, phone: organization?.phone, email: organization?.email,
  }

  const afterSent = async (result, destinationName) => {
    setShowNew(false)
    notify(`${result.transfer_number} sent to ${destinationName}. They need to confirm receipt.`, 'success')
    dispatchHealthflowDataChanged()
    await load()
    setOpenId(result.transfer_id)
  }

  const afterResolved = async (result) => {
    notify(
      result.status === 'received'
        ? `${result.transfer_number} received${result.discrepancy ? '. Short quantities went back to the sender.' : '.'}`
        : `${result.transfer_number} ${result.status}. The stock went back to the sending branch.`,
      'success'
    )
    dispatchHealthflowDataChanged()
    await load()
    setOpenId(result.transfer_id)
  }

  return (
    <main className="stx-page">
      <header className="stx-page-header">
        <div>
          <h1><ArrowRightLeft size={22} aria-hidden="true" /> Stock Transfers</h1>
          <p>Send stock between your main store and branches. The receiving branch confirms what arrived.</p>
        </div>
        <div className="stx-page-actions">
          <button type="button" className="btn btn-outline" onClick={() => { setLoading(true); load() }} disabled={loading}>
            <RefreshCcw size={16} /> Refresh
          </button>
          {mayAddBranch && (
            <button type="button" className="btn btn-outline" onClick={() => setShowAddBranch(true)}>
              <Plus size={16} /> Add branch
            </button>
          )}
          {canStartTransfer && (
            <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
              <Plus size={16} /> New transfer
            </button>
          )}
        </div>
      </header>

      {error && <div className="stx-alert" role="alert">{error}</div>}

      {!loading && activeBranches.length < 2 && (
        <div className="stx-empty">
          <strong>Transfers need at least two branches</strong>
          <span>
            {mayAddBranch
              ? (branchesLocked
                ? 'Multi-branch is not enabled for this pharmacy yet. Ask the platform administrator to enable it, then use Add branch.'
                : 'Use Add branch above, then you can move stock between locations.')
              : 'Ask an administrator or branch manager to add a branch.'}
          </span>
        </div>
      )}

      {transfers.length > 0 && (
        <div className="stx-toolbar">
          <div className="stx-filters" role="tablist" aria-label="Transfer status">
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
            <input type="search" placeholder="Search number, branch or medicine" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
      )}

      {loading ? (
        <div className="stx-empty">Loading transfers...</div>
      ) : transfers.length === 0 ? (
        activeBranches.length >= 2 && (
          <div className="stx-empty"><strong>No transfers yet</strong><span>Use New transfer to send stock from one branch to another.</span></div>
        )
      ) : visible.length === 0 ? (
        <div className="stx-empty"><strong>Nothing here</strong><span>No transfers match this view.</span></div>
      ) : (
        <div className="stx-table-wrap">
          <table className="stx-table stx-list">
            <thead>
              <tr><th>Transfer</th><th>Route</th><th className="num">Items</th><th>Status</th><th>Sent by</th><th aria-label="Open" /></tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const summary = summarizeTransfer(row)
                return (
                  <tr key={row.id} className={needsMyAction(actor, row) ? 'stx-row-action' : ''}>
                    <td><strong>{row.transfer_number}</strong><span className="stx-sub">{formatAppDateTime(row.created_at)}</span></td>
                    <td className="stx-route">{branchName(row.source_branch_id)} <ArrowRight size={14} aria-label="to" /> {branchName(row.destination_branch_id)}</td>
                    <td className="num">{summary.lines} line{summary.lines === 1 ? '' : 's'}<span className="stx-sub">{summary.totalSent} units</span></td>
                    <td>
                      <span className={`stx-badge stx-badge--${row.status}`}>{TRANSFER_STATUS_LABELS[row.status] || row.status}</span>
                      {summary.hasDiscrepancy && <span className="stx-flag">Short</span>}
                      {needsMyAction(actor, row) && <span className="stx-flag stx-flag--action">Confirm</span>}
                    </td>
                    <td>{row.created_by_name || '—'}</td>
                    <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setOpenId(row.id)}>Open</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewTransferModal branches={branches} actor={actor} onClose={() => setShowNew(false)} onSent={afterSent} />
      )}
      {showAddBranch && (
        <AddBranchModal
          locked={branchesLocked}
          onClose={() => setShowAddBranch(false)}
          onCreated={async (branch) => {
            setShowAddBranch(false)
            notify(`Branch "${branch?.name || 'New branch'}" created.`, 'success')
            await load()
          }}
        />
      )}
      {opened && (
        <TransferDetailModal
          key={`${opened.id}:${opened.status}`}
          transfer={opened} branchName={branchName} facility={facility} actor={actor}
          onClose={() => setOpenId(null)} onChanged={afterResolved}
        />
      )}
    </main>
  )
}

export default StockTransfers
