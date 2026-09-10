import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { shouldUseBranchServer } from '../services/branchServerApi'

export default function NhisClaimCreatorCounts() {
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(today)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState(null)
  const load = async () => {
    if (busy) return
    setError('')
    setRows(null)
    if (!from || !to || to < from) {
      setError('Choose a valid date range.')
      return
    }
    if (shouldUseBranchServer() || navigator.onLine === false) {
      setError('Connect to the cloud to count claims across the organization.')
      return
    }
    setBusy(true)
    try {
      const { data, error: requestError } = await supabase.rpc('get_nhis_claim_creator_counts', {p_from_date:from,p_to_date:to})
      if (requestError) throw requestError
      setRows(data || [])
      setRange({from,to})
    } catch {
      setError('Unable to load staff claim counts. Check your connection and retry. If this continues, contact your administrator.')
    } finally { setBusy(false) }
  }
  return (
    <details className="nhis-section">
      <summary>Claims created by staff</summary>
      <p>Counts by original creator and creation date (Ghana time), across all accessible claims. Includes drafts; edits and serving do not count as new claims.</p>
      <div className="form-row">
        <label>Created from <input type="date" value={from} disabled={busy} onChange={event=>setFrom(event.target.value)} /></label>
        <label>Created through <input type="date" value={to} disabled={busy} onChange={event=>setTo(event.target.value)} /></label>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={load}>{busy ? 'Counting...' : 'Show counts'}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {rows && <>
        <p>{range.from} through {range.to}: {rows.reduce((total,row)=>total+Number(row.claim_count),0)} claims</p>
        <table><thead><tr><th>Staff member</th><th>Claims created</th></tr></thead>
          <tbody>{rows.map(row=><tr key={row.creator_id || 'unassigned'}><td>{row.creator_name}</td><td>{row.claim_count}</td></tr>)}</tbody>
        </table>
        {rows.length === 0 && <p>No claims were created in this date range.</p>}
      </>}
    </details>
  )
}
