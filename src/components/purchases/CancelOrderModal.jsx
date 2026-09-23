import { useState } from 'react'
import { X } from 'lucide-react'
import { cancellationNeedsReason, getOrderTotals } from '../../utils/purchaseOrders'

// Cancelling never changes stock: anything already received stays received, and the
// remaining outstanding quantity simply stops counting as incoming.
export default function CancelOrderModal({ purchase, submitting = false, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const needsReason = cancellationNeedsReason(purchase)
  const { received, outstanding } = getOrderTotals(purchase)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (needsReason && !reason.trim()) {
      setError('Enter a reason for cancelling an order that has been placed.')
      return
    }
    setError('')
    await onConfirm(reason.trim())
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-panel modal-panel--cancel" onSubmit={handleSubmit} aria-label="Cancel order">
        <div className="modal-header">
          <h2>Cancel {purchase.purchase_number}?</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p>
            {received > 0
              ? `${received} unit${received === 1 ? '' : 's'} already received stay in stock. The remaining ${outstanding} will no longer count as incoming.`
              : 'Nothing has been received, so stock is not affected.'}
          </p>
          <label className="receive-notes">
            <span>Reason{needsReason ? ' (required)' : ' (optional)'}</span>
            <textarea rows="3" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          {error && <p className="receive-errors" role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Keep order</button>
          <button type="submit" className="btn btn-danger" disabled={submitting}>
            {submitting ? 'Cancelling…' : 'Cancel order'}
          </button>
        </div>
      </form>
    </div>
  )
}
