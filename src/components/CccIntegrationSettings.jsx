import { useEffect, useState } from 'react'
import { cccIntegration } from '../services/cccIntegrationService'

export default function CccIntegrationSettings({ organizationId }) {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    setData(null); setForm(null); setToken('')
    cccIntegration('get_ccc_policy', { organizationId }).then(result => {
      if (active) { setData(result); setForm(result.policy) }
    }).catch(error => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [organizationId])
  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const result = await cccIntegration('save_ccc_policy', { organizationId, provider: form.provider, enabled: form.enabled,
        expectedHpn: form.expectedHpn, expectedFacilityName: form.expectedFacilityName, bearerToken: token })
      setData(result); setForm(result.policy); setToken(''); setMessage('CCC settings saved.')
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  return <section aria-label="CCC integration">
    <h5>CCC integration</h5>
    {message && <p role="status">{message}</p>}
    {form && <form onSubmit={save}>
      <label>Provider <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
        <option value="existing">Existing NHIA API</option><option value="otac">NHIA OTAC</option>
      </select></label>
      <label><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Enable CCC generation</label>
      {form.provider === 'otac' && <>
        <label>Facility HPN <input value={form.expectedHpn} onChange={e => setForm({ ...form, expectedHpn: e.target.value })} /></label>
        <label>Exact NHIA facility name <input value={form.expectedFacilityName} onChange={e => setForm({ ...form, expectedFacilityName: e.target.value })} /></label>
        <label>New Bearer token <input type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} placeholder={form.hasToken ? 'Leave blank to retain saved token' : 'Facility OTAC token'} /></label>
        <p>Token expiry: {form.tokenExpiresAt || 'Not configured'}. Configuration checks token format, expiry and HPN; NHIA verifies authorization when attendance is requested.</p>
      </>}
      <p>Status: {data.policy.status}. An unresolved request must be checked with NHIA before another attempt. No automatic provider fallback.</p>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save CCC settings'}</button>
    </form>}
    {!!data?.requests?.length && <details><summary>Recent attendance requests</summary>
      {data.requests.map(request => <div key={request.id}><p>{request.created_at} — {request.provider}: {request.status} — {request.id}</p>
        {['pending', 'unknown'].includes(request.status) && <Reconcile organizationId={organizationId} requestId={request.id} onSaved={result => { setData(result); setForm(result.policy) }} />}
      </div>)}
    </details>}
    {!!data?.history?.length && <details><summary>Configuration history</summary>
      {data.history.map((entry, index) => <p key={index}>{entry.created_at} — {entry.action}: {entry.details.from} → {entry.details.to}</p>)}
    </details>}
  </section>
}

function Reconcile({ organizationId, requestId, onSaved }) {
  const [outcome, setOutcome] = useState('succeeded')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event) {
    event.preventDefault()
    const fields = Object.fromEntries(new FormData(event.currentTarget))
    setBusy(true)
    try {
      onSaved(await cccIntegration('reconcile_ccc_attendance', { ...fields, outcome, organizationId, requestId, confirmedWithNhia: true }))
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  return <details><summary>Reconcile with NHIA evidence</summary><form onSubmit={submit}>
    <p>Check this request with NHIA first. A timeout does not mean attendance was not created. Wait at least five minutes before reconciling.</p>
    <label>Confirmed outcome <select value={outcome} onChange={e => setOutcome(e.target.value)}><option value="succeeded">Attendance exists</option><option value="not_created">NHIA confirmed no attendance</option></select></label>
    {outcome === 'succeeded' && <>
      <label>CCC <input name="ccCode" required pattern="[0-9]{5}" /></label>
      <label>NHIA attendance ID <input name="authId" required /></label>
      <label>NHIA facility name <input name="facilityName" required /></label>
      <label>Attendance date <input name="attendanceDate" type="date" required /></label>
    </>}
    <label>NHIA verification evidence <textarea name="note" required minLength={20} maxLength={1000} /></label>
    <label><input type="checkbox" required /> I checked the actual outcome with NHIA.</label>
    <button disabled={busy}>Record verified outcome</button>
    {message && <p role="status">{message}</p>}
  </form></details>
}
