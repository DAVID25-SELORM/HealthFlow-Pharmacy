import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
export default function ClaimExportAlerts() {
 const {role,primaryRole,assignedRoles,profile}=useAuth()
 const allowed=primaryRole==='super_admin'||role==='super_admin'||role==='admin'||assignedRoles?.includes('admin')
 const [alerts,setAlerts]=useState([]),[failed,setFailed]=useState(false)
 useEffect(()=>{
  window.dispatchEvent(new CustomEvent('healthflow-export-alert-count',{detail:allowed?alerts.length:0}))
 },[alerts,allowed])
 useEffect(()=>{
  setAlerts([]);if(!allowed)return
  let active=true
  const load=async()=>{
   try {const {data,error}=await supabase.rpc('list_claim_export_alerts');if(active){setFailed(!!error);if(!error)setAlerts(data||[])}}
   catch{if(active)setFailed(true)}
  }
  const refresh=()=>{if(document.visibilityState!=='hidden')void load()}
  void load();const timer=setInterval(refresh,60000)
  window.addEventListener('focus',refresh)
  document.addEventListener('visibilitychange',refresh)
  return ()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
 },[allowed,profile?.id,profile?.organization_id])
 if(!allowed)return null
 return <details id="claim-export-notifications" className="platform-billing" open={alerts.length>0 || failed}><summary>Claims export notifications ({alerts.length}{alerts.length===100?'+':''} unread)</summary>
  {failed && <p role="alert">Export notifications could not be refreshed.</p>}
  {!failed&&!alerts.length&&<p>No unread claims export notifications.</p>}
  {alerts.map(a=><article className="billing-invoice" key={a.id}><strong>{a.facility_name}: {a.period.slice(0,7)}</strong><p>{a.claim_count} claims exported as CXF. Recorded {new Date(a.created_at).toLocaleString()}. This is not NHIA acceptance.</p><button onClick={async()=>{
   try{const {data,error}=await supabase.rpc('list_claim_export_alerts',{p_read_id:a.id});if(error)setFailed(true);else{setAlerts(data||[]);setFailed(false)}}catch{setFailed(true)}
  }}>Mark read</button></article>)}
 </details>
}
