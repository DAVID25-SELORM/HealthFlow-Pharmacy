import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import './PlatformBilling.css'
export default function ClaimExportAlerts({ visible = true }) {
 const {role,primaryRole,assignedRoles,profile,session,loading}=useAuth()
 const allowed=primaryRole==='super_admin'||role==='super_admin'||role==='admin'||assignedRoles?.includes('admin')
 const ready=allowed&&!loading&&!!session?.access_token
 const [alerts,setAlerts]=useState([]),[failed,setFailed]=useState(false)
 useEffect(()=>{
  window.dispatchEvent(new CustomEvent('healthflow-export-alert-count',{detail:ready?alerts.length:0}))
 },[alerts,ready])
 useEffect(()=>{
  setAlerts([]);setFailed(false);if(!ready)return
  let active=true,inFlight=false,unauthorized=false
  const load=async()=>{
   if(!active||inFlight||unauthorized)return
   inFlight=true
   try {const {data,error,status}=await supabase.rpc('list_claim_export_alerts');if(active){unauthorized=status===401;setFailed(!!error);if(!error)setAlerts(data||[])}}
   catch{if(active)setFailed(true)}
   finally{inFlight=false}
  }
  const refresh=()=>{if(document.visibilityState!=='hidden')void load()}
  void load();const timer=setInterval(refresh,60000)
  window.addEventListener('focus',refresh)
  document.addEventListener('visibilitychange',refresh)
  return ()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)}
 },[ready,session?.access_token,profile?.id,profile?.organization_id])
 if(!ready || !visible)return null
 return <details id="claim-export-notifications" className="platform-billing" open={alerts.length>0 || failed}><summary>Claims export notifications ({alerts.length}{alerts.length===100?'+':''} unread)</summary>
  {failed && <p role="alert">Export notifications could not be refreshed.</p>}
  {!failed&&!alerts.length&&<p>No unread claims export notifications.</p>}
  {alerts.map(a=><article className="billing-invoice" key={a.id}><strong>{a.facility_name}: {a.period.slice(0,7)}</strong><p>{a.claim_count} claims exported as CXF. Recorded {new Date(a.created_at).toLocaleString()}. This is not NHIA acceptance.</p><button onClick={async()=>{
   try{const {data,error}=await supabase.rpc('list_claim_export_alerts',{p_read_id:a.id});if(error)setFailed(true);else{setAlerts(data||[]);setFailed(false)}}catch{setFailed(true)}
  }}>Mark read</button></article>)}
 </details>
}
