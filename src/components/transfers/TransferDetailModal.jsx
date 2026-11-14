import { useMemo, useState } from 'react'
import { Printer, X } from 'lucide-react'
import {
  TRANSFER_STATUS,
  TRANSFER_STATUS_LABELS,
  cancelBranchTransfer,
  canCancelTransfer,
  canReceiveTransfer,
  receiveBranchTransfer,
  rejectBranchTransfer,
  summarizeTransfer,
} from '../../services/branchTransferService'
import { formatAppDate, formatAppDateTime } from '../../utils/date'

const num = (value) => Number.parseFloat(value) || 0
const QUANTITY = /^\d{1,8}(\.\d{1,2})?$/

export default function TransferDetailModal({ transfer, branchName, facility = {}, actor, onClose, onChanged }) {
  const [mode, setMode] = useState('view') // view | receive | reject | cancel
  const [received, setReceived] = useState(() =>
    Object.fromEntries((transfer.items || []).map((item) => [item.id, String(num(item.quantity_sent))])))
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const summary = summarizeTransfer(transfer)
  const pending = transfer.status === TRANSFER_STATUS.PENDING
  const mayReceive = canReceiveTransfer(actor, transfer)
  const mayCancel = canCancelTransfer(actor, transfer)
  const facilityAddress = [facility.address, facility.city, facility.region].filter(Boolean).join(', ')
  const receiving = mode === 'receive'

  const receiveProblem = useMemo(() => {
    if (!receiving) return ''
    let total = 0
    for (const item of transfer.items) {
      const value = String(received[item.id] ?? '').trim()
      if (!QUANTITY.test(value)) return `Enter the received quantity of ${item.medicine_name} (0 or more, 2 decimals at most).`
      if (num(value) > num(item.quantity_sent)) return `${item.medicine_name}: you cannot receive more than the ${num(item.quantity_sent)} sent.`
      total += num(value)
    }
    return total > 0 ? '' : 'Nothing received. Use Reject to send the whole transfer back.'
  }, [receiving, received, transfer.items])

  const shortLines = receiving
    ? transfer.items.filter((item) => num(received[item.id]) < num(item.quantity_sent) && QUANTITY.test(String(received[item.id] ?? '')))
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

  const confirmReceipt = () => run(() => receiveBranchTransfer({
    transferId: transfer.id,
    lines: transfer.items.map((item) => ({ itemId: item.id, quantityReceived: received[item.id] })),
    notes,
  }))
  const reject = () => run(() => rejectBranchTransfer({ transferId: transfer.id, reason }))
  const cancel = () => run(() => cancelBranchTransfer({ transferId: transfer.id, reason }))

  return (
    <div className="modal-overlay stx-print-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-content stx-modal stx-modal--detail" role="dialog" aria-label={`Transfer ${transfer.transfer_number}`}>
        <div className="modal-header stx-print-hide">
          <h2>Transfer {transfer.transfer_number}</h2>
          <div className="stx-header-buttons">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => window.print()}><Printer size={16} /> Print note</button>
            <button type="button" className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        <article className="stx-print-sheet">
          <header className="stx-sheet-header">
            <div>
              <h1>{facility.name || 'Pharmacy'}</h1>
              {facilityAddress && <p>{facilityAddress}</p>}
              {(facility.phone || facility.email) && <p>{[facility.phone, facility.email].filter(Boolean).join(' · ')}</p>}
            </div>
            <div className="stx-sheet-title">
              <h2>STOCK TRANSFER NOTE</h2>
              <p><strong>No:</strong> {transfer.transfer_number}</p>
              <p><strong>Date sent:</strong> {formatAppDateTime(transfer.created_at)}</p>
              <p><span className={`stx-badge stx-badge--${transfer.status}`}>{TRANSFER_STATUS_LABELS[transfer.status] || transfer.status}</span></p>
            </div>
          </header>

          <section className="stx-sheet-parties">
            <div><h3>From</h3><p><strong>{branchName(transfer.source_branch_id)}</strong></p><p>Sent by {transfer.created_by_name || 'staff member'}</p></div>
            <div><h3>To</h3><p><strong>{branchName(transfer.destination_branch_id)}</strong></p>
              {transfer.resolved_at && <p>{transfer.status === TRANSFER_STATUS.RECEIVED ? 'Received' : TRANSFER_STATUS_LABELS[transfer.status]} {formatAppDateTime(transfer.resolved_at)}{transfer.resolved_by_name ? ` by ${transfer.resolved_by_name}` : ''}</p>}
            </div>
          </section>
          {transfer.notes && <p className="stx-note"><strong>Note:</strong> {transfer.notes}</p>}

          <table className="stx-table">
            <thead>
              <tr>
                <th className="stx-col-opt">#</th><th>Medicine</th><th>Batch</th><th className="stx-col-opt">Expiry</th>
                <th className="num">Sent</th>
                <th className="num">{receiving ? 'Received *' : 'Received'}</th>
              </tr>
            </thead>
            <tbody>
              {transfer.items.map((item, index) => {
                const short = transfer.status === TRANSFER_STATUS.RECEIVED && num(item.quantity_received) < num(item.quantity_sent)
                return (
                  <tr key={item.id} className={short ? 'stx-row-short' : ''}>
                    <td className="stx-col-opt">{index + 1}</td>
                    <td><strong>{item.medicine_name}</strong></td>
                    <td>{item.batch_number || '—'}</td>
                    <td className="stx-col-opt">{item.expiry_date ? formatAppDate(item.expiry_date) : '—'}</td>
                    <td className="num">{num(item.quantity_sent)} {item.unit || ''}</td>
                    <td className="num">
                      {receiving ? (
                        <input
                          type="number" inputMode="decimal" min="0" step="0.01" max={num(item.quantity_sent)}
                          value={received[item.id] ?? ''}
                          onChange={(event) => setReceived((current) => ({ ...current, [item.id]: event.target.value }))}
                          aria-label={`Received quantity of ${item.medicine_name}`}
                        />
                      ) : transfer.status === TRANSFER_STATUS.RECEIVED ? (
                        <>{num(item.quantity_received)}{short && <span className="stx-sub"> short {num(item.quantity_sent) - num(item.quantity_received)}</span>}</>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {summary.hasDiscrepancy && (
            <p className="stx-note stx-note--warn">
              {summary.shortfall} unit(s) were short on arrival and went back to {branchName(transfer.source_branch_id)}.
            </p>
          )}
          {transfer.resolution_notes && <p className="stx-note"><strong>{transfer.status === TRANSFER_STATUS.RECEIVED ? 'Receiving note' : 'Reason'}:</strong> {transfer.resolution_notes}</p>}

          <div className="stx-signatures">
            <div><span /> Sent by (name, signature, date)</div>
            <div><span /> Received by (name, signature, date)</div>
          </div>
        </article>

        {pending && (mayReceive || mayCancel) && (
          <div className="stx-actions stx-print-hide">
            {mode === 'view' && (
              <>
                {mayReceive && <button type="button" className="btn btn-primary" onClick={() => setMode('receive')}>Confirm receipt</button>}
                {mayReceive && <button type="button" className="btn btn-outline" onClick={() => { setReason(''); setMode('reject') }}>Reject…</button>}
                {mayCancel && <button type="button" className="btn btn-outline" onClick={() => { setReason(''); setMode('cancel') }}>Cancel transfer…</button>}
              </>
            )}
            {receiving && (
              <div className="stx-confirm">
                <p className="stx-hint">Count what actually arrived. Anything short is returned to {branchName(transfer.source_branch_id)} automatically.</p>
                {shortLines.length > 0 && <p className="stx-note stx-note--warn">{shortLines.length} line(s) short: {shortLines.map((item) => item.medicine_name).join(', ')}.</p>}
                <label className="form-group"><span>Receiving note (optional)</span><textarea rows="2" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
                {receiveProblem && <p className="stx-error-text">{receiveProblem}</p>}
                <div className="stx-confirm-buttons">
                  <button type="button" className="btn btn-outline" onClick={() => setMode('view')} disabled={busy}>Back</button>
                  <button type="button" className="btn btn-primary" onClick={confirmReceipt} disabled={busy || Boolean(receiveProblem)}>{busy ? 'Saving...' : 'Confirm what arrived'}</button>
                </div>
              </div>
            )}
            {(mode === 'reject' || mode === 'cancel') && (
              <div className="stx-confirm">
                <p className="stx-hint">
                  {mode === 'reject'
                    ? `Everything goes back to ${branchName(transfer.source_branch_id)}. Tell them why.`
                    : `The stock goes back to ${branchName(transfer.source_branch_id)} and the receiving branch is no longer expecting it.`}
                </p>
                <label className="form-group"><span>Reason *</span><textarea rows="2" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label>
                <div className="stx-confirm-buttons">
                  <button type="button" className="btn btn-outline" onClick={() => setMode('view')} disabled={busy}>Back</button>
                  <button type="button" className="btn btn-primary" onClick={mode === 'reject' ? reject : cancel} disabled={busy || reason.trim().length < 5}>
                    {busy ? 'Saving...' : mode === 'reject' ? 'Reject transfer' : 'Cancel transfer'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {pending && !mayReceive && !mayCancel && (
          <p className="stx-hint stx-print-hide">Waiting for a manager or administrator at {branchName(transfer.destination_branch_id)} to confirm receipt.</p>
        )}
        {error && <div className="stx-alert stx-print-hide" role="alert">{error}</div>}
      </div>
    </div>
  )
}
