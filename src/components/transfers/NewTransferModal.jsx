import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Trash2, X } from 'lucide-react'
import { searchDrugs } from '../../services/drugService'
import { canSendFromBranch, dispatchBranchTransfer } from '../../services/branchTransferService'
import { formatAppDate } from '../../utils/date'

const todayKey = () => new Date().toISOString().slice(0, 10)
const available = (drug) => Number.parseFloat(drug?.quantity) || 0
const isExpired = (drug) => Boolean(drug?.expiry_date) && String(drug.expiry_date).slice(0, 10) < todayKey()

const lineError = (line) => {
  const value = Number.parseFloat(line.quantity)
  if (!line.quantity) return 'Enter a quantity.'
  if (!Number.isFinite(value) || value <= 0) return 'Quantity must be above zero.'
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(line.quantity).trim())) return 'Use at most 2 decimals.'
  if (value > line.available) return `Only ${line.available} in stock.`
  return ''
}

export default function NewTransferModal({ branches, actor, initial = null, onClose, onSent }) {
  const activeBranches = useMemo(() => branches.filter((row) => row.is_active !== false), [branches])
  const sendableBranches = useMemo(
    () => activeBranches.filter((row) => canSendFromBranch(actor, row.id)),
    [activeBranches, actor]
  )
  const [sourceId, setSourceId] = useState(
    () => initial?.sourceBranchId
      || sendableBranches.find((row) => row.id === actor.branchId)?.id
      || sendableBranches.find((row) => row.is_main)?.id
      || sendableBranches[0]?.id
      || ''
  )
  const [destinationId, setDestinationId] = useState('')
  const [lines, setLines] = useState(() => (initial?.drug ? [toLine(initial.drug)] : []))
  const [term, setTerm] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const destinations = activeBranches.filter((row) => row.id !== sourceId)
  const addedIds = useMemo(() => new Set(lines.map((line) => line.drugId)), [lines])

  useEffect(() => {
    const query = term.trim()
    if (!sourceId || query.length < 2) {
      setResults([])
      return undefined
    }
    const ticket = requestRef.current + 1
    requestRef.current = ticket
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const rows = await searchDrugs(query, { branchId: sourceId, inStockOnly: true, limit: 12 })
        if (requestRef.current === ticket) setResults(rows)
      } catch (searchError) {
        if (requestRef.current === ticket) setError(searchError.message || 'Search failed.')
      } finally {
        if (requestRef.current === ticket) setSearching(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [term, sourceId])

  const changeSource = (id) => {
    setSourceId(id)
    if (destinationId === id) setDestinationId('')
    setLines([]) // stock rows belong to the branch they were picked from
    setResults([])
  }

  const addDrug = (drug) => {
    if (addedIds.has(drug.id) || isExpired(drug)) return
    setLines((current) => [...current, toLine(drug)])
    setTerm('')
    setResults([])
  }

  const setQuantity = (drugId, quantity) =>
    setLines((current) => current.map((line) => (line.drugId === drugId ? { ...line, quantity } : line)))

  const problems = lines.map(lineError)
  const ready = sourceId && destinationId && lines.length > 0 && problems.every((message) => !message)

  const submit = async (event) => {
    event.preventDefault()
    if (!ready || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await dispatchBranchTransfer({
        sourceBranchId: sourceId,
        destinationBranchId: destinationId,
        items: lines.map((line) => ({ drugId: line.drugId, quantity: line.quantity })),
        notes,
      })
      onSent(result, activeBranches.find((row) => row.id === destinationId)?.name || '')
    } catch (sendError) {
      setError(sendError.message || 'The transfer could not be sent.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-content stx-modal" onSubmit={submit} aria-label="New stock transfer">
        <div className="modal-header">
          <h2>New stock transfer</h2>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="stx-form">
          <div className="stx-branch-row">
            <label className="form-group">
              <span>From branch *</span>
              <select value={sourceId} onChange={(event) => changeSource(event.target.value)} required>
                {sendableBranches.map((row) => <option key={row.id} value={row.id}>{row.name}{row.is_main ? ' (main store)' : ''}</option>)}
              </select>
            </label>
            <label className="form-group">
              <span>To branch *</span>
              <select value={destinationId} onChange={(event) => setDestinationId(event.target.value)} required>
                <option value="">Select branch</option>
                {destinations.map((row) => <option key={row.id} value={row.id}>{row.name}{row.is_main ? ' (main store)' : ''}</option>)}
              </select>
            </label>
          </div>

          <div className="stx-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search medicines in the sending branch to add..."
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              disabled={!sourceId}
              aria-label="Search medicines to add"
            />
          </div>
          {term.trim().length >= 2 && (
            <ul className="stx-results" aria-label="Search results">
              {searching && <li className="stx-muted">Searching...</li>}
              {!searching && results.length === 0 && <li className="stx-muted">No in-stock match at this branch.</li>}
              {results.map((drug) => (
                <li key={drug.id}>
                  <button type="button" onClick={() => addDrug(drug)} disabled={addedIds.has(drug.id) || isExpired(drug)}>
                    <strong>{drug.name}</strong>
                    <span>
                      {drug.batch_number ? `Batch ${drug.batch_number}` : 'No batch'}
                      {drug.expiry_date ? ` · exp ${formatAppDate(drug.expiry_date)}` : ''}
                      {` · ${available(drug)} ${drug.unit || 'units'} in stock`}
                      {isExpired(drug) ? ' · EXPIRED' : ''}
                      {addedIds.has(drug.id) ? ' · added' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lines.length === 0 ? (
            <p className="stx-muted stx-empty-lines">Search above and add the medicines to send. Each batch is its own line.</p>
          ) : (
            <table className="stx-table stx-lines">
              <thead>
                <tr><th>Medicine</th><th className="num">In stock</th><th className="num">Quantity to send</th><th aria-label="Remove" /></tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.drugId}>
                    <td>
                      <strong>{line.name}</strong>
                      <span className="stx-sub">{line.batch ? `Batch ${line.batch}` : 'No batch'}{line.expiry ? ` · exp ${formatAppDate(line.expiry)}` : ''}</span>
                    </td>
                    <td className="num">{line.available} {line.unit}</td>
                    <td className="num">
                      <input
                        type="number" inputMode="decimal" min="0.01" step="0.01" max={line.available}
                        value={line.quantity}
                        onChange={(event) => setQuantity(line.drugId, event.target.value)}
                        aria-label={`Quantity of ${line.name} to send`}
                        aria-invalid={Boolean(line.quantity && problems[index])}
                      />
                      {line.quantity && problems[index] && <span className="stx-error-text">{problems[index]}</span>}
                    </td>
                    <td>
                      <button type="button" className="icon-btn" onClick={() => setLines((current) => current.filter((row) => row.drugId !== line.drugId))} aria-label={`Remove ${line.name}`}>
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <label className="form-group">
            <span>Note (optional)</span>
            <textarea rows="2" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <p className="stx-hint">
            Stock leaves {branches.find((row) => row.id === sourceId)?.name || 'the sending branch'} as soon as you send. It only appears at the
            receiving branch when a manager or administrator there confirms what arrived.
          </p>
          {error && <div className="stx-alert" role="alert">{error}</div>}
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ready || submitting}>
            {submitting ? 'Sending...' : `Send ${lines.length || ''} ${lines.length === 1 ? 'medicine' : 'medicines'}`.replace('  ', ' ')}
          </button>
        </div>
      </form>
    </div>
  )
}

function toLine(drug) {
  return {
    drugId: drug.id,
    name: drug.name,
    batch: drug.batch_number || '',
    expiry: drug.expiry_date || '',
    unit: drug.unit || 'units',
    available: available(drug),
    quantity: '',
  }
}
