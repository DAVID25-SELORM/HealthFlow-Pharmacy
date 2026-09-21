import { useState } from 'react'
import { auditClaimItClaims, signNhisClaim, repairClaimItTotal } from '../services/claimitLifecycleService'

export default function ClaimItRemediation() {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [issue, setIssue] = useState('')
  const [status, setStatus] = useState('')
  const [exportState, setExportState] = useState('')
  const [cursor, setCursor] = useState(null)
  const run = async (action) => {
    setBusy(true); setError('')
    try { await action() } catch (err) { setError(err.message || 'Unable to complete claim review.') }
    finally { setBusy(false) }
  }
  const scan = async (apply = false, after = null) => {
    const result = await auditClaimItClaims({ apply, after, dateFrom, dateTo, status })
    setReport(result); setCursor(after)
  }
  return <section className="card" aria-label="Claim-IT signing and remediation">
    <button type="button" onClick={() => setOpen(!open)}>Claim-IT signing and legacy review</button>
    {open && <div>
      <p>Review the claim in the claims list before signing. Signing records your identity and the current time; it does not reconstruct a historical signature.</p>
      <label>From <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setReport(null) }} /></label>
      <label>To <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setReport(null) }} /></label>
      <label>Status <select value={status} onChange={(e) => { setStatus(e.target.value); setReport(null) }}>
        <option value="">All statuses</option>
        {['draft','pending','served','fully_served','partially_served','submitted','accepted','approved','paid','rejected'].map((value) => <option key={value}>{value}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => run(() => scan())}>Preview audit (100 claims)</button>
      {error && <p role="alert">{error}</p>}
      {report && <>
        <p>Safely repairable totals: {report.repairable ?? 0}. These claims may still require clinical or signer review after reconciliation.</p>
        <p>Scanned: {report.scanned} · Ready: {report.unchanged} · Requires review: {report.manual_review_required} · Automatically repaired: {report.automatically_repaired} · Errors: {report.errors}</p>
        <button type="button" disabled={busy} onClick={() => run(() => scan(true, cursor))}>Save review flags for this batch</button>
        <button type="button" disabled={busy || report.scanned < 100} onClick={() => run(() => scan(false, report.next_cursor))}>Next batch</button>
        <label>Issue <select value={issue} onChange={(e) => setIssue(e.target.value)}>
          <option value="">All issues</option>
          {Object.entries(report.counts).map(([key, count]) => <option key={key} value={key}>{key} ({count})</option>)}
        </select></label>
        <label>Export state in this batch <select value={exportState} onChange={(e) => setExportState(e.target.value)}>
          <option value="">All export states</option><option value="recorded">Recorded export</option><option value="unknown">No recorded export / legacy unknown</option>
        </select></label>
        <label>Reason for signing after review <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <table><thead><tr><th>Claim</th><th>Status</th><th>Review needed</th><th>Action</th></tr></thead><tbody>
          {report.rows.filter((row) => (!issue || row.issues.includes(issue)) && (!exportState || (exportState === 'recorded') === Boolean(row.hasRecordedExport))).map((row) => <tr key={row.id}>
            <td>{row.claimNumber}</td><td>{row.status}</td><td>{row.issues.join(', ') || 'Ready'}</td>
            <td><button type="button" disabled={busy || !reason.trim()} onClick={() => run(async () => {
              await signNhisClaim(row.id, reason)
              await scan(false, cursor)
            })}>Sign reviewed claim</button>
              {row.repairable === true && <button type="button" disabled={busy} onClick={() => run(async () => {
                await repairClaimItTotal(row.id, row.fingerprint)
                await scan(false, cursor)
              })}>Reconcile from verified lines</button>}
            </td>
          </tr>)}
        </tbody></table>
      </>}
    </div>}
  </section>
}
