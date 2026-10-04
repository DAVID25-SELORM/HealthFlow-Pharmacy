import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import './PlatformBilling.css'

const money = value => `GHS ${Number(value || 0).toFixed(2)}`
const monthLabel = value => new Date(`${value}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function BillingMonthPicker() {
  const current = new Date().toISOString().slice(0, 7)
  const [value, setValue] = useState(current)
  const [year, setYear] = useState(Number(current.slice(0, 4)))
  const firstYear = Number(current.slice(0, 4))
  const maximum = `${firstYear + 2}${current.slice(4)}`
  return <fieldset className="billing-month-picker">
    <legend>First billing month</legend>
    <input type="hidden" name="month" value={value} />
    <label>Year<select value={year} onChange={e => setYear(Number(e.target.value))}>
      {[firstYear, firstYear + 1, firstYear + 2].map(y => <option key={y} value={y}>{y}</option>)}
    </select></label>
    <div className="billing-month-grid">{Array.from({ length: 12 }, (_, index) => {
      const month = `${year}-${String(index + 1).padStart(2, '0')}`
      return <button key={month} type="button" aria-label={monthLabel(month)} aria-pressed={value === month}
        disabled={month < current || month > maximum} onClick={() => setValue(month)}>
        {monthLabel(month).split(' ')[0].slice(0, 3)}
      </button>
    })}</div>
    <small>Selected: <strong>{monthLabel(value)}</strong>. Billing starts in this month.</small>
  </fieldset>
}
export default function PlatformBilling() {
  const { role, assignedRoles } = useAuth()
  const platform = role === 'super_admin'
  const allowed = platform || role === 'admin' || assignedRoles?.includes('admin')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [facility, setFacility] = useState('')
  const [filter, setFilter] = useState('all')
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
  const selected = data?.facilities?.find(f => f.id === facility)
  const visibleInvoices = invoices.filter(i =>
    (!platform || !facility || i.organization_id === facility) &&
    (filter === 'all' || (filter === 'paid' ? !!i.paid_at : filter === 'pending'
      ? pending.some(p => p.invoice_id === i.id) : !i.paid_at)))
  return <section className="platform-billing" aria-label="Subscription billing">
    <div className="billing-summary">
      <div><span className="billing-eyebrow">MONTHLY SUBSCRIPTION</span>
      <h2>{platform ? 'Platform billing' : 'Your subscription'}</h2>
      <p>{data ? `${money(outstanding)} outstanding${platform ? ' across all facilities' : ''}` : 'Loading your billing details...'}</p></div>
      {pending.length > 0 && <span className="billing-badge pending">{pending.length} awaiting confirmation</span>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide billing' : 'View billing / Pay'}</button>
    </div>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => run()}>Retry</button></p>}
    {message && <p role="status">{message}</p>}
    {open && <>
      <div className="billing-stats">
        <div><span>Total outstanding</span><strong>{money(outstanding)}</strong></div>
        <div><span>Awaiting confirmation</span><strong>{money(pending.reduce((sum, p) => sum + Number(p.amount), 0))}</strong></div>
        <div><span>Unpaid invoices</span><strong>{invoices.filter(i => !i.paid_at).length}</strong></div>
      </div>
      <p className="billing-help">Balances remain outstanding until payment is confirmed. Pharmacy and NHIS operations continue while payment is outstanding.</p>
      {platform && <div className="billing-plan"><h3>Set a facility's monthly charge</h3><p>Select a facility to view or update its subscription plan.</p><form className="billing-form billing-plan-form" onSubmit={e => {
        e.preventDefault(); const form = new FormData(e.currentTarget)
        void run('set_plan', { organization_id: form.get('facility'), amount: form.get('amount'), starts_on: `${form.get('month') || new Date().toISOString().slice(0, 7)}-01`, due_day: Number(form.get('day')) })
      }}>
        <label className="billing-facility-field">Facility<select name="facility" value={facility} onChange={e => setFacility(e.target.value)} required><option value="">Select facility</option>{data?.facilities.map(f => <option key={f.id} value={f.id}>{f.name}{f.amount ? ` - ${money(f.amount)}/month` : ''}</option>)}</select></label>
        <label>Monthly amount (GHS)<input key={`amount-${facility}-${selected?.amount}`} name="amount" type="number" min="0.01" step="0.01" defaultValue={selected?.amount || ''} placeholder="e.g. 250.00" required /></label>
        {selected?.starts_on ? <div className="billing-saved-start"><strong>First billing month</strong><p>{monthLabel(selected.starts_on.slice(0, 7))}</p><small>Already saved. Updating the charge does not change this start month.</small></div> : <BillingMonthPicker key={facility} />}
        <label>Due day (1-28)<input key={`day-${facility}-${selected?.due_day}`} name="day" type="number" min="1" max="28" defaultValue={selected?.due_day || 5} required /></label>
        <button className="billing-primary" disabled={busy || !data || !facility}>{busy ? 'Saving...' : 'Save monthly charge'}</button>
        <small>Existing invoices keep their original amount. For existing plans, the first billing month stays unchanged.</small>
      </form></div>}
      {!platform && data && <div className="billing-recipient"><span className="billing-eyebrow">PAY WITH MOBILE MONEY</span><h3>{data.recipient.number}</h3><strong>{data.recipient.name}</strong><p>Send the exact invoice amount, using its invoice reference. Then enter your MoMo transaction ID below. Your payment stays pending until confirmed.</p></div>}
      <div className="billing-invoice-heading"><h3>Invoices {platform && selected ? `for ${selected.name}` : ''}</h3><label>Show<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All invoices</option><option value="unpaid">Outstanding</option><option value="pending">Awaiting confirmation</option><option value="paid">Paid</option></select></label></div>
      {!visibleInvoices.length && <div className="billing-empty"><strong>{busy ? 'Loading invoices...' : 'No invoices to show'}</strong><p>{platform ? 'Configure a monthly charge above, or choose another invoice filter.' : 'Your invoices will appear here once your facility billing plan begins.'}</p></div>}
      {visibleInvoices.map(i => {
        const history = payments.filter(p => p.invoice_id === i.id)
        const waiting = history.find(p => p.status === 'pending')
        return <article key={i.id} className="billing-invoice">
          <div className="billing-invoice-title"><div><strong>{platform ? `${i.facility} - ` : ''}{i.period.slice(0, 7)}</strong><p>Due {i.due_on}</p></div><strong className="billing-amount">{money(i.amount)}</strong><span className={`billing-badge ${i.paid_at ? 'paid' : waiting ? 'pending' : 'unpaid'}`}>{i.paid_at ? 'Paid' : waiting ? 'Awaiting confirmation' : 'Unpaid'}</span></div>
          {waiting && <p className="billing-help">Payment submitted. Do not pay this invoice again while it is being reviewed.</p>}
          <small>Invoice reference: {i.id}</small>
          {!platform && !i.paid_at && !waiting && <form className="billing-form" onSubmit={e => {
            e.preventDefault(); void run('submit', { invoice_id: i.id, reference: new FormData(e.currentTarget).get('reference') })
          }}>
            <label>MoMo transaction ID<input name="reference" minLength="4" maxLength="100" required /></label>
            <button className="billing-primary" disabled={busy}>I have paid {money(i.amount)}</button>
          </form>}
          {history.map(p => <div key={p.id} className="billing-payment">
            <p>Transaction <strong>{p.transaction_reference}</strong>: {p.status}{p.review_note ? ` - ${p.review_note}` : ''}{p.reviewed_at ? ` (${new Date(p.reviewed_at).toLocaleDateString()})` : ''}</p>
            {platform && p.status === 'pending' && <form className="billing-form" onSubmit={e => {
              e.preventDefault(); const form = new FormData(e.currentTarget)
              void run('review', { payment_id: p.id, decision: form.get('decision'), note: form.get('note') })
            }}>
              <label>Decision<select name="decision"><option value="approved">Confirm money received</option><option value="rejected">Reject submission</option></select></label>
              <label>Review note (required for rejection)<input name="note" maxLength="500" /></label>
              <label className="billing-confirm"><input type="checkbox" required />I checked the transaction against the MoMo account.</label>
              <button className="billing-primary" disabled={busy}>Save decision</button>
            </form>}
          </div>)}
        </article>
      })}
      <button disabled={busy} onClick={() => run()}>Refresh billing</button>
    </>}
  </section>
}
