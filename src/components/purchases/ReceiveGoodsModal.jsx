import { useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { describePriceChange } from '../../utils/reorderInsights'
import {
  buildInitialReceiptLines,
  createReceiptKey,
  getOrderedQuantity,
  getOutstandingQuantity,
  getReceivedQuantity,
  toReceiptPayload,
  validateReceiptLines,
} from '../../utils/purchaseOrders'

// Records goods that have actually arrived against a placed order. Stock is only added
// when this is submitted. Each item shows ordered / received / outstanding; a delivery
// that arrives in more than one batch can be split into extra lines for the same item.
export default function ReceiveGoodsModal({ purchase, submitting = false, onClose, onSubmit }) {
  const [lines, setLines] = useState(() => buildInitialReceiptLines(purchase))
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState([])
  // One key for this whole session: a retry or double click can never post the delivery twice.
  const receiptKey = useRef(createReceiptKey())

  const items = useMemo(() => new Map((purchase.purchase_items || []).map((item) => [item.id, item])), [purchase])

  const updateLine = (key, field, value) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, [field]: value } : line)))

  const addBatchLine = (itemId) =>
    setLines((current) => {
      const index = current.reduce((last, line, i) => (line.itemId === itemId ? i : last), -1)
      const source = items.get(itemId)
      const next = {
        key: `${itemId}-${Date.now()}`,
        itemId,
        quantity: '',
        batchNumber: '',
        expiryDate: '',
        unitCost: source?.unit_cost == null ? '' : String(source.unit_cost),
      }
      return [...current.slice(0, index + 1), next, ...current.slice(index + 1)]
    })

  const removeLine = (key) => setLines((current) => current.filter((line) => line.key !== key))

  const handleSubmit = async (event) => {
    event.preventDefault()
    const result = validateReceiptLines(lines, purchase)
    setErrors(result.errors)
    if (result.errors.length > 0) return
    await onSubmit(toReceiptPayload(result.lines), { receiptKey: receiptKey.current, notes })
  }

  const receivingNow = lines.reduce((sum, line) => sum + (Number.parseFloat(line.quantity) || 0), 0)
  const rowsPerItem = lines.reduce((counts, line) => ({ ...counts, [line.itemId]: (counts[line.itemId] || 0) + 1 }), {})

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-panel modal-panel--receive" onSubmit={handleSubmit} aria-label="Receive goods">
        <div className="modal-header">
          <h2>Receive goods — {purchase.purchase_number}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="modal-body">
          <p className="receive-intro">
            Enter what actually arrived, from the delivery note. Stock is only added for the quantities
            you record here; anything not received stays outstanding on the order.
          </p>

          {lines.length === 0 ? (
            <p className="receive-empty">Nothing is outstanding on this order.</p>
          ) : (
            <div className="receive-lines">
              {lines.map((line) => {
                const item = items.get(line.itemId)
                const first = lines.find((l) => l.itemId === line.itemId)?.key === line.key
                return (
                  <div key={line.key} className={`receive-line ${first ? '' : 'receive-line--extra'}`}>
                    <div className="receive-line-head">
                      {first ? (
                        <>
                          <strong>{item?.drug_name}</strong>
                          <span className="receive-line-status">
                            Ordered {getOrderedQuantity(item)} · Received {getReceivedQuantity(item)} · Outstanding {getOutstandingQuantity(item)}
                          </span>
                        </>
                      ) : (
                        <span className="receive-line-status">Another batch of {item?.drug_name}</span>
                      )}
                    </div>
                    <div className="receive-line-fields">
                      <label>
                        <span>Quantity received</span>
                        <input
                          type="number" min="0" step="any" inputMode="decimal"
                          value={line.quantity}
                          onChange={(event) => updateLine(line.key, 'quantity', event.target.value)}
                        />
                      </label>
                      <label>
                        <span>Batch no.</span>
                        <input type="text" value={line.batchNumber} onChange={(event) => updateLine(line.key, 'batchNumber', event.target.value)} />
                      </label>
                      <label>
                        <span>Expiry date</span>
                        <input type="date" value={line.expiryDate} onChange={(event) => updateLine(line.key, 'expiryDate', event.target.value)} />
                      </label>
                      <label>
                        <span>Unit cost (GHS)</span>
                        <input
                          type="number" min="0" step="0.01" inputMode="decimal"
                          value={line.unitCost}
                          onChange={(event) => updateLine(line.key, 'unitCost', event.target.value)}
                        />
                        {(() => {
                          const change = describePriceChange(line.unitCost, item?.unit_cost)
                          if (!change || change.changePercent === null || change.changePercent === 0) return null
                          const sign = change.changePercent > 0 ? '+' : ''
                          return (
                            <small className={change.flagged ? 'receive-price-flagged' : 'receive-price-note'}>
                              {sign}{change.changePercent}% vs ordered cost{change.flagged ? ' — please check the invoice' : ''}
                            </small>
                          )
                        })()}
                      </label>
                    </div>
                    <div className="receive-line-actions">
                      {first && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => addBatchLine(line.itemId)}>
                          + Another batch
                        </button>
                      )}
                      {!first && rowsPerItem[line.itemId] > 1 && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => removeLine(line.key)}>
                          Remove batch
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <label className="receive-notes">
            <span>Delivery note / comments (optional)</span>
            <textarea rows="2" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          {errors.length > 0 && (
            <ul className="receive-errors" role="alert">
              {errors.map((message) => <li key={message}>{message}</li>)}
            </ul>
          )}
        </div>

        <div className="modal-footer">
          <span className="receive-summary">Receiving now: {receivingNow}</span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || lines.length === 0}>
            {submitting ? 'Receiving…' : 'Receive stock'}
          </button>
        </div>
      </form>
    </div>
  )
}
