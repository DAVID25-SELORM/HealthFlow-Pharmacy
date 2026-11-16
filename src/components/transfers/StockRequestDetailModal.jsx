import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  REQUEST_STATUS,
  REQUEST_STATUS_LABELS,
  approveBranchStockRequest,
  canCancelRequest,
  canDecideRequest,
  cancelBranchStockRequest,
  declineBranchStockRequest,
} from '../../services/branchStockRequestService'
import { formatAppDate, formatAppDateTime } from '../../utils/date'

const num = (value) => Number.parseFloat(value) || 0
const QUANTITY = /^\d{1,8}(\.\d{1,2})?$/

export default function StockRequestDetailModal({ request, branchName, actor, onClose, onChanged }) {
  const [mode, setMode] = useState('view') // view | approve | decline | cancel
  const [approved, setApproved] = useState(() =>
    Object.fromEntries((request.items || []).map((item) => [item.id, String(num(item.quantity_requested))])))
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pending = request.status === REQUEST_STATUS.PENDING
  const mayDecide = canDecideRequest(actor, request)
  const mayCancel = canCancelRequest(actor, request)
  const approving = mode === 'approve'
  const source = branchName(request.source_branch_id)
  const requesting = branchName(request.requesting_branch_id)

  const approveProblem = useMemo(() => {
    if (!approving) return ''
    let total = 0
    for (const item of request.items) {
      const value = String(approved[item.id] ?? '').trim()
      if (!QUANTITY.test(value)) return `Enter the quantity to send of ${item.medicine_name} (0 or more, 2 decimals at most).`
      if (num(value) > num(item.quantity_requested)) return `${item.medicine_name}: you cannot send more than the ${num(item.quantity_requested)} asked for.`
      total += num(value)
    }
    return total > 0 ? '' : 'Nothing to send. Use Decline to turn the whole request down.'
  }, [approving, approved, request.items])

  const reduced = approving
    ? request.items.filter((item) => QUANTITY.test(String(approved[item.id] ?? '')) && num(approved[item.id]) < num(item.quantity_requested))
    : []

  const run = async (action) => {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      await onChanged(result)
    } catch (actionError) {
      setError(actionError.message || 'That did not go through.')
      setBusy(false)
    }
  }

  const approve = () => run(() => approveBranchStockRequest({
    requestId: request.id,
    lines: request.items.map((item) => ({ itemId: item.id, quantityApproved: approved[item.id] })),
    notes,
  }))
  const decline = () => run(() => declineBranchStockRequest({ requestId: request.id, reason }))
  const cancel = () => run(() => cancelBranchStockRequest({ requestId: request.id, reason }))

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-content stx-modal stx-modal--detail" role="dialog" aria-label={`Request ${request.request_number}`}>
        <div className="modal-header">
          <h2>Request {request.request_number}</h2>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="stx-form">
          <p>
            <span className={`stx-badge stx-badge--${request.status}`}>{REQUEST_STATUS_LABELS[request.status] || request.status}</span>
            {' '}<strong>{requesting}</strong> asked <strong>{source}</strong> for stock on {formatAppDateTime(request.created_at)}
            {request.created_by_name ? ` (${request.created_by_name})` : ''}.
          </p>
          {request.notes && <p className="stx-note"><strong>Note:</strong> {request.notes}</p>}

          <table className="stx-table">
            <thead>
              <tr>
                <th>Medicine</th><th>Batch</th><th className="stx-col-opt">Expiry</th>
                <th className="num">Asked</th>
                <th className="num">{approving ? 'Send *' : 'Approved'}</th>
              </tr>
            </thead>
            <tbody>
              {request.items.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.medicine_name}</strong></td>
                  <td>{item.batch_number || '—'}</td>
                  <td className="stx-col-opt">{item.expiry_date ? formatAppDate(item.expiry_date) : '—'}</td>
                  <td className="num">{num(item.quantity_requested)} {item.unit || ''}</td>
                  <td className="num">
                    {approving ? (
                      <input
                        type="number" inputMode="decimal" min="0" step="0.01" max={num(item.quantity_requested)}
                        value={approved[item.id] ?? ''}
                        onChange={(event) => setApproved((current) => ({ ...current, [item.id]: event.target.value }))}
                        aria-label={`Quantity of ${item.medicine_name} to send`}
                      />
                    ) : request.status === REQUEST_STATUS.APPROVED ? num(item.quantity_approved) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {request.resolved_at && (
            <p className="stx-note">
              <strong>{REQUEST_STATUS_LABELS[request.status]}</strong> {formatAppDateTime(request.resolved_at)}
              {request.resolved_by_name ? ` by ${request.resolved_by_name}` : ''}
              {request.resolution_notes ? `: ${request.resolution_notes}` : ''}
            </p>
          )}
          {request.status === REQUEST_STATUS.APPROVED && (
            <p className="stx-hint">The stock was sent as a transfer. {requesting} confirms what arrived on the Transfers tab.</p>
          )}
        </div>

        {pending && (mayDecide || mayCancel) && (
          <div className="stx-actions">
            {mode === 'view' && (
              <>
                {mayDecide && <button type="button" className="btn btn-primary" onClick={() => setMode('approve')}>Approve…</button>}
                {mayDecide && <button type="button" className="btn btn-outline" onClick={() => { setReason(''); setMode('decline') }}>Decline…</button>}
                {mayCancel && <button type="button" className="btn btn-outline" onClick={() => { setReason(''); setMode('cancel') }}>Cancel request…</button>}
              </>
            )}
            {approving && (
              <div className="stx-confirm">
                <p className="stx-hint">
                  Lower a quantity, or set it to 0 to leave a line out. The stock leaves {source} as soon as you approve, and
                  {' '}{requesting} then confirms what arrived.
                </p>
                {reduced.length > 0 && <p className="stx-note stx-note--warn">Sending less than asked: {reduced.map((item) => item.medicine_name).join(', ')}.</p>}
                <label className="form-group"><span>Note to {requesting} (optional)</span><textarea rows="2" maxLength={400} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
                {approveProblem && <p className="stx-error-text">{approveProblem}</p>}
                <div className="stx-confirm-buttons">
                  <button type="button" className="btn btn-outline" onClick={() => setMode('view')} disabled={busy}>Back</button>
                  <button type="button" className="btn btn-primary" onClick={approve} disabled={busy || Boolean(approveProblem)}>{busy ? 'Sending...' : 'Approve and send'}</button>
                </div>
              </div>
            )}
            {(mode === 'decline' || mode === 'cancel') && (
              <div className="stx-confirm">
                <p className="stx-hint">
                  {mode === 'decline'
                    ? `${requesting} will see your reason. No stock moves.`
                    : `${source} will no longer see this request. No stock moves.`}
                </p>
                <label className="form-group"><span>Reason *</span><textarea rows="2" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label>
                <div className="stx-confirm-buttons">
                  <button type="button" className="btn btn-outline" onClick={() => setMode('view')} disabled={busy}>Back</button>
                  <button type="button" className="btn btn-primary" onClick={mode === 'decline' ? decline : cancel} disabled={busy || reason.trim().length < 5}>
                    {busy ? 'Saving...' : mode === 'decline' ? 'Decline request' : 'Cancel request'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {pending && !mayDecide && !mayCancel && (
          <p className="stx-hint">Waiting for an administrator or staff at {source} to approve or decline.</p>
        )}
        {error && <div className="stx-alert" role="alert">{error}</div>}
      </div>
    </div>
  )
}
