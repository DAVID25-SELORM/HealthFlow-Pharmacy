import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Trash2, X } from 'lucide-react'
import { createBranchStockRequest, searchBranchStockForRequest } from '../../services/branchStockRequestService'
import { formatAppDate } from '../../utils/date'

const available = (drug) => Number.parseFloat(drug?.quantity) || 0

const lineError = (line) => {
  const value = Number.parseFloat(line.quantity)
  if (!line.quantity) return 'Enter a quantity.'
  if (!Number.isFinite(value) || value <= 0) return 'Quantity must be above zero.'
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(line.quantity).trim())) return 'Use at most 2 decimals.'
  return ''
}

// A branch asks another branch (normally the main store) for stock. Nothing moves until the other side approves.
export default function NewStockRequestModal({ branches, actor, onClose, onSent }) {
  const activeBranches = useMemo(() => branches.filter((row) => row.is_active !== false), [branches])
  const ownBranch = activeBranches.find((row) => row.id === actor.branchId) || null
  const askable = useMemo(() => activeBranches.filter((row) => row.id !== actor.branchId), [activeBranches, actor.branchId])
  const [sourceId, setSourceId] = useState(() => (askable.find((row) => row.is_main) || askable[0])?.id || '')
  const [lines, setLines] = useState([])
  const [term, setTerm] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const addedIds = useMemo(() => new Set(lines.map((line) => line.drugId)), [lines])
  const sourceName = askable.find((row) => row.id === sourceId)?.name || 'the other branch'

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
        const rows = await searchBranchStockForRequest({ sourceBranchId: sourceId, term: query, limit: 12 })
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
    setLines([]) // each line is a batch held by the branch it was picked from
    setResults([])
  }

  const addDrug = (drug) => {
    if (addedIds.has(drug.id)) return
    setLines((current) => [...current, {
      drugId: drug.id,
      name: drug.name,
      batch: drug.batch_number || '',
      expiry: drug.expiry_date || '',
      unit: drug.unit || 'units',
      available: available(drug),
      quantity: '',
    }])
    setTerm('')
    setResults([])
  }

  const setQuantity = (drugId, quantity) =>
    setLines((current) => current.map((line) => (line.drugId === drugId ? { ...line, quantity } : line)))

  const problems = lines.map(lineError)
  const ready = Boolean(ownBranch && sourceId && lines.length > 0 && problems.every((message) => !message))

  const submit = async (event) => {
    event.preventDefault()
    if (!ready || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await createBranchStockRequest({
        sourceBranchId: sourceId,
        requestingBranchId: ownBranch.id,
        items: lines.map((line) => ({ drugId: line.drugId, quantity: line.quantity })),
        notes,
      })
      onSent(result, sourceName)
    } catch (sendError) {
      setError(sendError.message || 'The request could not be sent.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-content stx-modal" onSubmit={submit} aria-label="Request stock">
        <div className="modal-header">
          <h2>Request stock</h2>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="stx-form">
          <div className="stx-branch-row">
            <label className="form-group">
              <span>Ask *</span>
              <select value={sourceId} onChange={(event) => changeSource(event.target.value)} required>
                {askable.map((row) => <option key={row.id} value={row.id}>{row.name}{row.is_main ? ' (main store)' : ''}</option>)}
              </select>
            </label>
            <label className="form-group">
              <span>Stock goes to</span>
              <input value={ownBranch?.name || 'Your branch'} readOnly aria-label="Stock goes to" />
            </label>
          </div>

          <div className="stx-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder={`Search medicines held by ${sourceName}...`}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              disabled={!sourceId}
              aria-label="Search medicines to request"
            />
          </div>
          {term.trim().length >= 2 && (
            <ul className="stx-results" aria-label="Search results">
              {searching && <li className="stx-muted">Searching...</li>}
              {!searching && results.length === 0 && <li className="stx-muted">No in-stock match at {sourceName}.</li>}
              {results.map((drug) => (
                <li key={drug.id}>
                  <button type="button" onClick={() => addDrug(drug)} disabled={addedIds.has(drug.id)}>
                    <strong>{drug.name}</strong>
                    <span>
                      {drug.batch_number ? `Batch ${drug.batch_number}` : 'No batch'}
                      {drug.expiry_date ? ` · exp ${formatAppDate(drug.expiry_date)}` : ''}
                      {` · ${available(drug)} ${drug.unit || 'units'} available`}
                      {addedIds.has(drug.id) ? ' · added' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lines.length === 0 ? (
            <p className="stx-muted stx-empty-lines">Search above and add the medicines you need. Each batch is its own line.</p>
          ) : (
            <table className="stx-table stx-lines">
              <thead>
                <tr><th>Medicine</th><th className="num">Available</th><th className="num">Quantity needed</th><th aria-label="Remove" /></tr>
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
                        type="number" inputMode="decimal" min="0.01" step="0.01"
                        value={line.quantity}
                        onChange={(event) => setQuantity(line.drugId, event.target.value)}
                        aria-label={`Quantity of ${line.name} needed`}
                        aria-invalid={Boolean(line.quantity && problems[index])}
                      />
                      {line.quantity && problems[index] && <span className="stx-error-text">{problems[index]}</span>}
                      {!problems[index] && Number.parseFloat(line.quantity) > line.available && (
                        <span className="stx-sub">More than is available now; they may send less.</span>
                      )}
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
            Nothing moves yet. {sourceName} will approve or decline your request. If they approve, they send the stock and
            you confirm what arrived on this page.
          </p>
          {error && <div className="stx-alert" role="alert">{error}</div>}
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ready || submitting}>
            {submitting ? 'Sending...' : 'Send request'}
          </button>
        </div>
      </form>
    </div>
  )
}
