import { useState } from 'react'
import { collectionsReport, collectionsCsv } from '../utils/collectionsReport'
const money = value => `GHS ${(value / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export default function BillingCollections({ data }) {
 const [facility,setFacility]=useState(''), [from,setFrom]=useState(''), [to,setTo]=useState('')
 const invalid=!!(from && to && from>to)
 const report=collectionsReport(data,facility,from,to)
 const exportCsv=()=>{
  const url=URL.createObjectURL(new Blob(['\uFEFF'+collectionsCsv(report.rows)],{type:'text/csv;charset=utf-8;'}))
  const link=document.createElement('a');link.href=url;link.download=`billing-statement-${from || 'all'}-${to || 'dates'}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
 }
 return <details className="billing-plan" open><summary>Collections and facility statements</summary>
  <div className="billing-form">
   <label>Statement facility<select value={facility} onChange={e=>setFacility(e.target.value)}><option value="">All facilities</option>{data.facilities?.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
   <label>From date<input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label>
   <label>To date<input type="date" value={to} onChange={e=>setTo(e.target.value)} /></label>
   <button type="button" onClick={()=>{setFrom('');setTo('');setFacility('')}}>Clear filters</button>
   <button type="button" disabled={invalid || !report.rows.length} onClick={exportCsv}>Export statement CSV</button>
  </div>
  {invalid ? <p role="alert">The end date must be on or after the start date.</p> : <>
   <div className="billing-stats">
    <div><span>Confirmed collections</span><strong>{money(report.received)}</strong></div>
    <div><span>Subscription collections</span><strong>{money(report.subscription)}</strong></div>
    <div><span>Onboarding collections</span><strong>{money(report.onboarding)}</strong></div>
    <div><span>Pending submissions (not income)</span><strong>{money(report.pending)}</strong></div>
    <div><span>Current outstanding (all dates)</span><strong>{money(report.outstanding)}</strong></div>
   </div>
   <p className="billing-help">Collections use the recorded receipt date, or confirmation date when no receipt date is available. Pending and rejected entries use submission date. Dates include both endpoints. Outstanding is the current unpaid balance for the selected facility, independent of date filters.</p>
   <p className="billing-help">Multi-month receipts appear as one allocation per invoice; each allocation is counted once. This report covers recorded platform fees, not expenses or profit.</p>
   <div style={{overflowX:'auto',marginTop:'1rem'}}><table className="billing-statement"><caption>Payment statement ({report.rows.length} allocations)</caption><thead><tr>{['Date','Facility','Type / month','Reference','Status','Amount'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{report.rows.map(p=><tr key={p.id}><td>{p.date}<small>{p.dateBasis}</small></td><td>{p.facility}</td><td>{p.kind === 'onboarding' ? 'Onboarding' : `Subscription ${p.period?.slice(0,7)}`}</td><td>{p.reference}</td><td>{p.status}</td><td>{money(Math.round(Number(p.amount)*100))}</td></tr>)}</tbody></table></div>
   {!report.rows.length && <p className="billing-empty">No payments match these filters.</p>}
  </>}
 </details>
}
