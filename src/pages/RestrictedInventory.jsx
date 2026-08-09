import { useCallback, useEffect, useState } from 'react'
import { History, RefreshCw, ShieldAlert } from 'lucide-react'
import { useTenant } from '../context/TenantContext'
import {
  getRestrictedInventory,
  getRestrictedInventoryAudit,
  updateRestrictedInventoryStatus,
} from '../services/restrictedInventoryService'
import './RestrictedInventory.css'

const STATUSES = [
  ['quarantined', 'Quarantined'],
  ['under_review', 'Under review'],
  ['returned_to_supplier', 'Returned to supplier'],
  ['transferred_to_authorized_facility', 'Transferred to authorized facility'],
  ['destroyed', 'Destroyed'],
]

const RestrictedInventory = () => {
  const { organizationId } = useTenant()
  const [items, setItems] = useState([])
  const [audit, setAudit] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState('under_review')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems(await getRestrictedInventory(organizationId))
    } catch (loadError) {
      setError(loadError?.message || 'Restricted inventory could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => { void load() }, [load])

  const viewAudit = async (itemId) => {
    setSelectedId(itemId)
    setError('')
    try {
      setAudit(await getRestrictedInventoryAudit(organizationId, itemId))
    } catch (auditError) {
      setError(auditError?.message || 'Audit history could not be loaded.')
    }
  }

  const saveStatus = async (itemId) => {
    setError('')
    try {
      await updateRestrictedInventoryStatus(itemId, status, reason)
      setReason('')
      await load()
      await viewAudit(itemId)
    } catch (saveError) {
      setError(saveError?.message || 'The compliance action could not be saved.')
    }
  }

  return (
    <main className="restricted-inventory-page">
      <header className="restricted-inventory-header">
        <div><span>COMPLIANCE</span><h1>Restricted Inventory</h1><p>Review quarantined Chemical Shop stock and its audit trail.</p></div>
        <button type="button" onClick={() => void load()} title="Refresh restricted inventory"><RefreshCw size={17} /> Refresh</button>
      </header>
      {error && <div className="restricted-inventory-error" role="alert">{error}</div>}
      {loading ? <div className="restricted-inventory-empty">Loading restricted inventory...</div> : items.length === 0 ? (
        <div className="restricted-inventory-empty"><ShieldAlert size={28} /><strong>No quarantined stock</strong><span>No restricted stock is recorded for this Chemical Shop.</span></div>
      ) : (
        <div className="restricted-inventory-table-wrap"><table><thead><tr><th>Medicine</th><th>Quantity</th><th>Source / received</th><th>Reason</th><th>Status</th><th>Compliance action</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td><strong>{item.medicine_name}</strong></td><td>{item.quantity}</td><td>{item.source || '-'}<small>{item.received_at ? new Date(item.received_at).toLocaleString() : 'Date not recorded'}</small></td><td>{item.quarantine_reason}</td><td>{item.status.replaceAll('_', ' ')}</td><td><button type="button" className="icon-action" onClick={() => void viewAudit(item.id)} title="View audit history"><History size={17} /></button>{selectedId === item.id && <div className="restricted-status-editor"><select value={status} onChange={(event) => setStatus(event.target.value)}>{STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required action reason" /><button type="button" onClick={() => void saveStatus(item.id)}>Record action</button></div>}</td></tr>)}
        </tbody></table></div>
      )}
      {selectedId && <section className="restricted-audit"><h2>Audit history</h2>{audit.map((entry) => <div key={entry.id}><strong>{entry.action.replaceAll('_', ' ')}</strong><span>{entry.reason || '-'}</span><span>{entry.actor_name || entry.actor_email || 'System'}</span><time>{new Date(entry.created_at).toLocaleString()}</time></div>)}</section>}
    </main>
  )
}

export default RestrictedInventory
