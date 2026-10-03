import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import './PlatformBilling.css'

const money = value => `GHS ${Number(value || 0).toFixed(2)}`
export default function PlatformBilling() {
  const { role, assignedRoles } = useAuth()
  const platform = role === 'super_admin'
  const allowed = platform || role === 'admin' || assignedRoles?.includes('admin')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const run = useCallback(async (action = 'list', payload = {}) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const { data: result, error: failure } = await supabase.rpc('platform_billing', { p_action: action, p_data: payload })
      if (failure) throw failure
      setData(result)
      if (action !== 'list') setMessage(action === 'submit' ? 'Payment submitted. Awaiting confirmation; do not pay this invoice again.' : 'Billing updated.')
    } catch (failure) { setError(failure.message || 'Unable to load billing. Please retry.') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { if (allowed) void run() }, [allowed, run])
  if (!allowed) return null
  const invoices = data?.invoices || []
  const payments = data?.payments || []
  const outstanding = invoices.filter(i => !i.paid_at).reduce((total, i) => total + Number(i.amount), 0)
  const pending = payments.filter(p => p.status === 'pending')
  return <section className="platform-billing" aria-label="Subscription billing">
    <div className="billing-summary">
      <strong>{platform ? 'Platform subscription billing' : data ? `Subscription outstanding: ${money(outstanding)}` : 'Subscription billing'}</strong>
      {pending.length > 0 && <span>{pending.length} payment(s) awaiting confirmation</span>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide billing' : 'View billing / Pay'}</button>
    </div>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => run()}>Retry</button></p>}
    {message && <p role="status">{message}</p>}
    {open && <>
      <p>Monthly subscription payments. Pharmacy and NHIS operations continue while payment is outstanding.</p>
      {platform && <form className="billing-form" onSubmit={e => {
        e.preventDefault(); const form = new FormData(e.currentTarget)
        void run('set_plan', { organization_id: form.get('facility'), amount: form.get('amount'), starts_on: `${form.get('month')}-01`, due_day: Number(form.get('day')) })
      }}>
        <label>Facility<select name="facility" required><option value="">Select facility</option>{data?.facilities.map(f => <option key={f.id} value={f.id}>{f.name}{f.amount ? ` ? ${money(f.amount)}/month` : ''}</option>)}</select></label>
        <label>Monthly amount (GHS)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>First billing month<input name="month" type="month" min={new Date().toISOString().slice(0, 7)} defaultValue={new Date().toISOString().slice(0, 7)} required /></label>
        <label>Due day (1?28)<input name="day" type="number" min="1" max="28" defaultValue="5" required /></label>
        <button disabled={busy}>Save monthly charge</button>
        <small>Existing invoices keep their original amount. For existing plans, the first billing month stays unchanged.</small>
      </form>}
      {!platform && <p>Send the exact invoice amount to <strong>{data?.recipient.number} ? {data?.recipient.name}</strong>. Use the invoice reference below, then submit your MoMo transaction ID. Submission alone does not confirm receipt.</p>}
      {!invoices.length && <p>No invoices have been issued.</p>}
      {invoices.map(i => {
        const history = payments.filter(p => p.invoice_id === i.id)
        const waiting = history.find(p => p.status === 'pending')
        return <article key={i.id} className="billing-invoice">
          <strong>{platform ? `${i.facility} ? ` : ''}{i.period.slice(0, 7)}: {money(i.amount)}</strong>
          <p>Due {i.due_on} ? {i.paid_at ? 'Paid ? confirmed' : waiting ? 'Awaiting confirmation ? do not pay again' : 'Unpaid'}</p>
          <small>Invoice reference: {i.id}</small>
          {!platform && !i.paid_at && !waiting && <form className="billing-form" onSubmit={e => {
            e.preventDefault(); void run('submit', { invoice_id: i.id, reference: new FormData(e.currentTarget).get('reference') })
          }}>
            <label>MoMo transaction ID<input name="reference" minLength="4" maxLength="100" required /></label>
            <button disabled={busy}>I have paid {money(i.amount)}</button>
          </form>}
          {history.map(p => <div key={p.id}>
            <p>Transaction {p.transaction_reference}: {p.status}{p.review_note ? ` ? ${p.review_note}` : ''}{p.reviewed_at ? ` (${new Date(p.reviewed_at).toLocaleDateString()})` : ''}</p>
            {platform && p.status === 'pending' && <form className="billing-form" onSubmit={e => {
              e.preventDefault(); const form = new FormData(e.currentTarget)
              void run('review', { payment_id: p.id, decision: form.get('decision'), note: form.get('note') })
            }}>
              <label>Decision<select name="decision"><option value="approved">Confirm money received</option><option value="rejected">Reject submission</option></select></label>
              <label>Review note (required for rejection)<input name="note" maxLength="500" /></label>
              <label><input type="checkbox" required />I checked the transaction against the MoMo account.</label>
              <button disabled={busy}>Save decision</button>
            </form>}
          </div>)}
        </article>
      })}
      <button disabled={busy} onClick={() => run()}>Refresh billing</button>
    </>}
  </section>
}
