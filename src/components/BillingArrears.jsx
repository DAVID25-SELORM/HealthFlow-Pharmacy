import { useState } from 'react'
import { supabase } from '../lib/supabase'
export default function BillingArrears({ facility, onSaved }) {
 const [months,setMonths]=useState('1'),[amount,setAmount]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState(null)
 const save=async e=>{
  e.preventDefault(); if(busy || result?.saved)return
  const form=new FormData(e.currentTarget);setBusy(true);setResult(null)
  try {
   const {data,error}=await supabase.rpc('platform_billing_arrears',{p_data:{organization_id:facility.id,first_month:`${form.get('year')}-${form.get('month')}-01`,months:Number(months),monthly_amount:amount,due_on:form.get('due'),note:form.get('note')}})
   if(error)throw error
   onSaved(data);setResult({saved:true,text:`Previous outstanding charges saved: GHS ${(Number(amount)*Number(months)).toFixed(2)} across ${months} month(s).`})
  }catch(error){setResult({saved:false,text:error.message || 'Unable to save charges. Refresh billing before retrying.'})}
  finally{setBusy(false)}
 }
 return <details className="billing-plan"><summary>Record previous outstanding charges</summary>
  <p>Facility: <strong>{facility?.name || 'Select a facility above'}</strong>. Add only unpaid months that have no invoice yet. Existing invoices, including paid months, are never replaced.</p>
  <form className="billing-form" onSubmit={save} onChange={()=>setResult(null)}>
   <label>First unpaid year<select name="year" required defaultValue=""><option value="">Select year</option>{Array.from({length:new Date().getUTCFullYear()-1999},(_,n)=>new Date().getUTCFullYear()-n).map(y=><option key={y}>{y}</option>)}</select></label>
   <label>First unpaid month<select name="month" required defaultValue=""><option value="">Select month</option>{Array.from({length:12},(_,n)=>n+1).map(m=><option key={m} value={String(m).padStart(2,'0')}>{new Date(Date.UTC(2020,m-1,1)).toLocaleString('en-GB',{month:'long',timeZone:'UTC'})}</option>)}</select></label>
   <label>Unpaid months<input type="number" min="1" max="120" required value={months} onChange={e=>setMonths(e.target.value)} /></label>
   <label>Amount owed per month (GHS)<input type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)} /></label>
   <label>Arrears due date<input name="due" type="date" min="2000-01-01" required /></label>
   <label>Reason for arrears<input name="note" maxLength="500" required /></label>
   <p className="billing-history-facility">Total to add: <strong>GHS {(Number(months)*Number(amount)).toFixed(2)}</strong>. All selected months must be before the current month. The due date applies to every invoice in this batch.</p>
   <label className="billing-confirm"><input type="checkbox" required />I checked these months are unpaid and the charges are correct.</label>
   {result && <p className="billing-history-facility" role={result.saved?'status':'alert'}>{result.text}</p>}
   <button className="billing-primary" disabled={!facility || busy || result?.saved}>{busy?'Saving charges...':result?.saved?'Charges recorded':'Save previous outstanding charges'}</button>
  </form>
 </details>
}
