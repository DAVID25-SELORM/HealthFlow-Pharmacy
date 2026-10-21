import { useEffect, useState } from 'react'
import './CccIntegrationSettings.css'
import { cccIntegration } from '../services/cccIntegrationService'

export default function CccIntegrationSettings({ organizationId }) {
  return <FacilityCccIntegrationSettings key={organizationId} organizationId={organizationId} />
}

function FacilityCccIntegrationSettings({ organizationId }) {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [token, setToken] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    setData(null); setForm(null); setToken(''); setApiKey(''); setApiSecret(''); setMessage(''); setSaved(false)
    cccIntegration('get_ccc_policy', { organizationId }).then(result => {
      if (active) { setData(result); setForm({...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})}) }
    }).catch(error => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [organizationId])
  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage(''); setSaved(false)
    try {
      const result = await cccIntegration('save_ccc_policy', { organizationId, provider: form.provider, enabled: form.provider==='nehfams'?false:form.enabled,
        environment: form.environment || 'production', expectedHpn: form.expectedHpn, expectedFacilityName: form.expectedFacilityName, bearerToken: form.provider === 'otac' ? token : '',
        ...(form.provider === 'nehfams' ? { nehfamsApiKey: apiKey, nehfamsApiSecret: apiSecret } : {}) })
      setData(result); setForm({...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})}); setToken(''); setApiKey(''); setApiSecret(''); setSaved(true); setMessage('')
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  async function connectionAction(action) {
    setBusy(true); setMessage('')
    try {
      const result=await cccIntegration(action,{organizationId,environment:form.environment || 'production'})
      setData(result);setForm({...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})})
    } catch(error) {setMessage(error.message)} finally {setBusy(false)}
  }
  const selectedConnection=data?.nehfamsConnections?.find(c=>c.environment===(form?.environment || 'production'))
  const statusLabels = { test_configured: 'NeHFAMS test enabled', production_configured: 'NeHFAMS production enabled (limited)', validation_pending: 'NeHFAMS validation pending', disabled: 'Generation paused', existing_configuration: 'Existing provider', needs_token: 'Token required', needs_renewal: 'Token renewal needed', configured: 'OTAC configured' }
  return <section className="ccc-settings" aria-label="CCC integration">
    <header className="ccc-header">
      <div><span className="ccc-eyebrow">NHIA CONNECTION</span><h3>CCC integration</h3><p>Choose how this facility generates its CCCs.</p></div>
      {data && <span className="ccc-status">{statusLabels[data.policy.status] || 'Review configuration'}</span>}
    </header>
    {message && <p className="ccc-message" role="status">{message}</p>}
    {!form && !message && <p role="status">Loading connection settings...</p>}
    {form && <form onSubmit={save} onChange={() => setSaved(false)}>
      <fieldset className="ccc-providers" disabled={busy}>
        <legend>1. Choose a provider</legend>
        {[['existing', 'Existing NHIA API', 'Continue using the existing API configuration.'], ['otac', 'NHIA OTAC (Bearer token)', 'Connect with an authorized facility Bearer token.'], ['nehfams', 'NHIA NeHFAMS / OTAC', 'Separate API key and secret. Attendance generation is not available yet.']].map(([value, title, description]) =>
          <label key={value} className={`ccc-provider ${form.provider === value ? 'selected' : ''}`}>
            <input type="radio" name={`ccc-provider-${organizationId}`} value={value} checked={form.provider === value} onChange={() => { setToken(''); setApiKey(''); setApiSecret(''); setForm({ ...form, provider: value, enabled: value === 'nehfams' ? false : form.enabled }) }} />
            <span><strong>{title}</strong><small>{description}</small></span>
          </label>)}
      </fieldset>
      {form.provider === 'otac' && <div className="ccc-credentials">
        <h4>2. Connect this facility</h4>
        <p>Enter the details and token for the NHIA OTAC account of this facility.</p>
        <div className="ccc-field-grid">
          <label>Facility HPN<input required value={form.expectedHpn} onChange={e => setForm({ ...form, expectedHpn: e.target.value })} placeholder="e.g. 295" /></label>
          <label>Exact NHIA facility name<input required value={form.expectedFacilityName} onChange={e => setForm({ ...form, expectedFacilityName: e.target.value })} placeholder="As registered with NHIA" /></label>
        </div>
        <label className="ccc-token">New Bearer token<input type="password" autoComplete="new-password" spellCheck={false} required={!form.hasToken} value={token} onChange={e => setToken(e.target.value)} placeholder={form.hasToken ? 'Leave blank to keep the saved token' : 'Paste the facility token here'} /></label>
        <small>Paste the token with or without Bearer. It stays saved and encrypted until you replace it. Leave this field blank to keep it. Do not paste the API key or API secret here.</small>
        <div className="ccc-token-info"><strong>{form.hasToken ? 'A token is saved' : 'No token saved yet'}</strong><span>Expires: {form.tokenExpiresAt ? new Date(form.tokenExpiresAt).toLocaleString() : 'Shown after saving'}</span></div>
        {form.hasToken && <SavedToken key={`${organizationId}-${form.version}`} organizationId={organizationId} />}
        <p className="ccc-help">Saved provider and facility details remain until you change and save them. Token expiry does not erase your settings.</p>
        <p className="ccc-help">Saving checks the token format, expiry and facility HPN. NHIA verifies authorization when you generate attendance.</p>
      </div>}
      {form.provider === 'nehfams' && <div className="ccc-credentials">
        <h4>2. Prepare this facility's NeHFAMS connection</h4>
        <label>Environment<select value={form.environment || 'production'} onChange={e=>{setApiKey('');setApiSecret('');setForm({...form,environment:e.target.value,enabled:false,expectedHpn:data?.nehfamsConnections?.find(c=>c.environment===e.target.value)?.expectedHpn || '',expectedFacilityName:data?.nehfamsConnections?.find(c=>c.environment===e.target.value)?.expectedFacilityName || ''})}}><option value="test">NHIA test</option><option value="production">Production (generation disabled)</option></select></label>
        <label>Expected facility HPN<input required value={form.expectedHpn || ''} onChange={e=>setForm({...form,expectedHpn:e.target.value})}/></label>
        <label>Expected facility name<input required value={form.expectedFacilityName || ''} onChange={e=>setForm({...form,expectedFacilityName:e.target.value})}/></label>
        <p>Server: {form.environment==='test'?'https://elig.nhia.gov.gh:5007':'https://nehfams.nhia.gov.gh'}</p>
        <button type="button" disabled={busy || !selectedConnection} onClick={()=>connectionAction('validate_nehfams_connection')}>Validate saved connection</button>
        {selectedConnection?.validated && <p>Validated {selectedConnection.expectedFacilityName}: {selectedConnection.authMode}. OTAC {selectedConnection.otacRequired?'required':'not required'}.</p>}
        {form.environment==='test' && <button type="button" disabled={busy || !selectedConnection?.validated || !data?.nehfamsTestEnabled} onClick={()=>connectionAction('activate_nehfams_test')}>Enable authorized test attendance</button>}
        {form.environment==='production' && <p>{data?.nehfamsProductionApproval ? `Approved production attendances remaining: ${data.nehfamsProductionApproval.remaining} of ${data.nehfamsProductionApproval.limit}.` : 'Production NeHFAMS is not approved for this facility.'}</p>}
        {form.environment==='production' && <button type="button" disabled={busy || !selectedConnection?.validated || !data?.nehfamsProductionEnabled || !data?.nehfamsProductionApproval?.remaining} onClick={()=>connectionAction('activate_nehfams_production')}>Enable approved production attendance</button>}
        <p role="status">Saving this selection pauses CCC generation for this facility. Attendance remains disabled until NHIA responses and facility identity are validated.</p>
        <label>NeHFAMS API key<input type="password" autoComplete="new-password" required={!selectedConnection && !(form.environment!=='test' && data?.nehfamsReusableCredentials)} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={selectedConnection ? 'Leave blank to retain saved key' : (form.environment!=='test' && data?.nehfamsReusableCredentials) ? 'Saved facility API key will be reused' : 'Facility API key'} /></label>
        <label>NeHFAMS API secret<input type="password" autoComplete="new-password" required={!selectedConnection && !(form.environment!=='test' && data?.nehfamsReusableCredentials)} value={apiSecret} onChange={e => setApiSecret(e.target.value)} placeholder={selectedConnection ? 'Leave blank to retain saved secret' : (form.environment!=='test' && data?.nehfamsReusableCredentials) ? 'Saved facility API secret will be reused' : 'Facility API secret'} /></label>
        <p>{selectedConnection ? 'NeHFAMS credentials are saved separately.' : (form.environment!=='test' && data?.nehfamsReusableCredentials) ? 'Your saved facility API key and secret will be reused when you save. Leave both fields blank; enter both only to use different credentials.' : 'No NeHFAMS credentials saved.'} Existing NHIA and Bearer-token OTAC credentials are retained.</p>
      </div>}
      <div className="ccc-enable"><label><input type="checkbox" disabled={form.provider === 'nehfams'} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> <span><strong>Enable CCC generation</strong><small>Allow staff to generate codes using the selected provider.</small></span></label></div>
      <footer className="ccc-footer"><p>Changes apply after saving. Unresolved attendance must be checked with NHIA before switching providers.</p><button type="submit" disabled={busy}>{busy ? 'Saving...' : saved ? 'Saved' : 'Save CCC settings'}</button></footer>
      <div aria-live="polite" aria-atomic="true">{saved && <p className="ccc-save-success" role="status">CCC settings saved successfully. Your facility configuration has been updated.</p>}</div>
    </form>}
    {!!data?.requests?.length && <details><summary>Recent attendance requests</summary>
      {data.requests.map(request => <article className="ccc-request" key={request.id}>
        <div className="ccc-request-heading"><strong>Member: {request.member_number || 'Not available'}</strong><span className={`ccc-request-status ${request.status}`}>{request.status === 'unknown' ? 'Unknown - needs review' : request.status === 'pending' ? 'Pending - needs review' : request.status === 'succeeded' ? 'Succeeded' : 'Not created'}</span></div>
        <dl className="ccc-request-details">
          <div><dt>Card type</dt><dd>{request.card_type === 'NHISCARD' ? 'NHIS card' : request.card_type === 'GHANACARD' ? 'Ghana card' : request.card_type || 'Not available'}</dd></div>
          <div><dt>Environment</dt><dd>{request.environment || 'production'}</dd></div>
          <div><dt>Attendance date</dt><dd>{request.attendance_date || 'Not available'}</dd></div>
          <div><dt>Provider</dt><dd>{request.provider === 'nehfams' ? 'NHIA NeHFAMS / OTAC' : request.provider === 'otac' ? 'NHIA OTAC' : request.provider === 'existing' ? 'Existing NHIA API' : 'Unknown provider'}</dd></div>
          <div><dt>Requested (Ghana time)</dt><dd>{new Date(request.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Accra' })}</dd></div>
          <div className="ccc-request-reference"><dt>HealthFlow request ID</dt><dd>{request.id}</dd></div>
        </dl>
        {request.error_code && <p className="ccc-help">{request.error_code === 'reconciliation_required' ? 'The attendance outcome needs verification with NHIA.' : `Request issue: ${request.error_code}`}</p>}
        {['pending', 'unknown'].includes(request.status) && <Reconcile organizationId={organizationId} requestId={request.id} attendanceDate={request.attendance_date} onSaved={result => { setData(result); setForm({...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})}) }} />}
      </article>)}
    </details>}
    {!!data?.history?.length && <details><summary>Configuration history</summary>
      {data.history.map((entry, index) => <p key={index}>{entry.created_at} — {entry.action}: {entry.details.from} → {entry.details.to}</p>)}
    </details>}
  </section>
}

function Reconcile({ organizationId, requestId, attendanceDate, onSaved }) {
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
      <label>Attendance date <input name="attendanceDate" type="date" defaultValue={attendanceDate} required /></label>
    </>}
    <label>NHIA verification evidence <textarea name="note" required minLength={20} maxLength={1000} /></label>
    <label><input type="checkbox" required /> I checked the actual outcome with NHIA.</label>
    <button disabled={busy}>Record verified outcome</button>
    {message && <p role="status">{message}</p>}
  </form></details>
}

function SavedToken({ organizationId }) {
  const [revealed, setRevealed] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!revealed) return undefined
    let active = true
    cccIntegration('reveal_ccc_token', { organizationId }).then(result => {
      if (active) setValue(result.bearerToken)
    }).catch(err => { if (active) setError(err.message) })
    return () => { active = false }
  }, [revealed, organizationId])
  return <div className="ccc-saved-token">
    <button type="button" aria-expanded={revealed} onClick={() => { setValue(''); setError(''); setRevealed(!revealed) }}>{revealed ? 'Hide saved Bearer token' : 'View saved Bearer token'}</button>
    {revealed && <>{error ? <p role="alert">{error}</p> : value ? <label>Saved Bearer token<textarea readOnly value={value} rows={4} spellCheck={false} /></label> : <p role="status">Loading saved token...</p>}</>}
  </div>
}
