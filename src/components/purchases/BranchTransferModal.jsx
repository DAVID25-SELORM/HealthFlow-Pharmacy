import { useState } from 'react'
import { X } from 'lucide-react'
import {
  defaultTransferQuantity,
  describeTransferSource,
  validateTransferQuantity,
} from '../../utils/branchTransfer'

// Offers to move existing stock from another branch instead of buying it. Advisory: nothing
// moves until "Transfer stock" is pressed, and the transfer itself is the existing, audited
// transfer_drug_to_branch(). Buying the rest still works as usual afterwards.
export default function BranchTransferModal({
  drugName,
  unit = 'unit',
  suggestedQuantity,
  destinationBranchName,
  options,
  submitting = false,
  onClose,
  onConfirm,
}) {
  const [selectedId, setSelectedId] = useState(options[0]?.source_drug_id || '')
  const selected = options.find((option) => option.source_drug_id === selectedId) || null
  const [quantity, setQuantity] = useState(() => defaultTransferQuantity(options[0], suggestedQuantity))
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')

  const choose = (option) => {
    setSelectedId(option.source_drug_id)
    setQuantity(defaultTransferQuantity(option, suggestedQuantity))
    setError('')
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    const problem = validateTransferQuantity(quantity, selected)
    setError(problem)
    if (problem) return
    await onConfirm({ option: selected, quantity: Number.parseFloat(quantity), notes })
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal-panel modal-panel--transfer" onSubmit={handleSubmit} aria-label="Transfer stock instead of buying">
        <div className="modal-header">
          <h2>Transfer instead of buying — {drugName}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body reorder-transfer-body">
          <p>
            {destinationBranchName || 'This branch'} needs about <strong>{suggestedQuantity}</strong> {unit}.
            These branches have stock above their own reorder level. Nothing moves until you confirm.
          </p>

          <fieldset className="reorder-transfer-options">
            <legend>Transfer from</legend>
            {options.map((option) => (
              <label key={option.source_drug_id} className="reorder-transfer-option">
                <input
                  type="radio"
                  name="transfer-source"
                  checked={selectedId === option.source_drug_id}
                  onChange={() => choose(option)}
                />
                <span>
                  {describeTransferSource(option)}
                  <em>{option.spare_quantity} spare of {option.source_quantity}</em>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="reorder-transfer-field">
            <span>Quantity to transfer</span>
            <input type="number" min="0" step="any" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </label>
          <label className="reorder-transfer-field">
            <span>Note (optional)</span>
            <input type="text" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          {error && <p className="receive-errors" role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Not now</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Transferring…' : 'Transfer stock'}
          </button>
        </div>
      </form>
    </div>
  )
}
