import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import './PlatformBilling.css'
import '../styles/dashboardDesign.css'

export default function DashboardBills() {
  const { role, assignedRoles, profile } = useAuth()
  const allowed = ['admin', 'pharmacist'].includes(role) || assignedRoles?.some(r => ['admin', 'pharmacist'].includes(r))
  const canManage = role === 'admin' || assignedRoles?.includes('admin')
  const [bills, setBills] = useState([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setBills([]); setFailed(false)
    if (!allowed || !profile?.organization_id) return undefined
    let active = true
    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('get_my_outstanding_bills')
        if (active) { setFailed(!!error); setBills(error ? [] : data || []) }
      } catch { if (active) setFailed(true) }
    }
    void load()
    window.addEventListener('focus', load)
    return () => { active = false; window.removeEventListener('focus', load) }
  }, [allowed, profile?.id, profile?.organization_id])
  if (!allowed || !profile?.organization_id || (!bills.length && !failed)) return null
  const money = amount => `GH₵${Number(amount).toFixed(2)}`
  return <section className="platform-billing dashboard-bills" aria-label="Outstanding facility bills">
    <h2>Outstanding facility bills</h2>
    {failed ? <p role="status">Unable to check outstanding bills. Refresh to try again.</p> : <>
      <p><strong>{money(bills.reduce((sum, bill) => sum + Number(bill.amount), 0))}</strong> outstanding. Payments awaiting confirmation remain outstanding until approved.</p>
      {bills.map(bill => <article className="billing-invoice" key={bill.id}>
        <strong>{bill.kind === 'onboarding' ? 'Onboarding fee' : `Subscription — ${bill.period.slice(0, 7)}`}: {money(bill.amount)}</strong>
        <p>Due {bill.due_on}{bill.awaiting_confirmation ? ' · Payment awaiting confirmation' : ' · Unpaid'}</p>
      </article>)}
      {canManage ? <Link to="/billing">View bills / Pay</Link> : <p>Contact your facility administrator to arrange payment.</p>}
    </>}
  </section>
}
