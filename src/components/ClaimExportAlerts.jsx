import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
export default function ClaimExportAlerts() {
 const {role,assignedRoles,profile}=useAuth()
 const allowed=role==='super_admin'||role==='admin'||assignedRoles?.includes('admin')
 const [alerts,setAlerts]=useState([]),[failed,setFailed]=useState(false)
 useEffect(()=>{
  setAlerts([]);if(!allowed)return
  let active=true
  const load=async()=>{
   try {const {data,error}=await supabase.rpc('list_claim_export_alerts');if(active){setFailed(!!error);if(!error)setAlerts(data||[])}}
   catch{if(active)setFailed(true)}
  }
  void load();const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load()},60000)
  return ()=>{active=false;clearInterval(timer)}
 },[allowed,profile?.id,profile?.organization_id])
 if(!allowed)return null
 return <details className="platform-billing"><summary>Claims export notifications ({alerts.length}{alerts.length===100?'+':''} unread)</summary>
  {failed && <p role="alert">Export notifications could not be refreshed.</p>}
  {!failed&&!alerts.length&&<p>No unread claims export notifications.</p>}
  {alerts.map(a=><article className="billing-invoice" key={a.id}><strong>{a.facility_name}: {a.period.slice(0,7)}</strong><p>{a.claim_count} claims exported as CXF. Recorded {new Date(a.created_at).toLocaleString()}. This is not NHIA acceptance.</p><button onClick={async()=>{
   try{const {data,error}=await supabase.rpc('list_claim_export_alerts',{p_read_id:a.id});if(error)setFailed(true);else{setAlerts(data||[]);setFailed(false)}}catch{setFailed(true)}
  }}>Mark read</button></article>)}
 </details>
}
