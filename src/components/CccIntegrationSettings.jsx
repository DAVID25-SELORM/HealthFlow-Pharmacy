import { useEffect, useRef, useState } from 'react'
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
  const [operation, setOperation] = useState('')
  const [message, setMessage] = useState('')
  const editRevision = useRef(0)
  async function fillFacility() {
    const revision=editRevision.current
    setBusy(true); setOperation('discover'); setMessage('')
    try {
      const result=await cccIntegration('discover_nehfams_facility',{organizationId,environment:form.environment || 'production',nehfamsApiKey:apiKey,nehfamsApiSecret:apiSecret})
      if(revision!==editRevision.current) { setMessage('Details changed during lookup. Get facility details again.'); return }
      setForm(current=>({...current,expectedHpn:result.expectedHpn,expectedFacilityName:result.expectedFacilityName}))
      setSaved(false); setMessage('Facility details filled from NHIA. Confirm this is the intended facility, then save.')
    } catch(error) { setMessage(error.message) } finally { setBusy(false) }
  }
  useEffect(() => {
    let active = true
    setData(null); setForm(null); setToken(''); setApiKey(''); setApiSecret(''); setMessage(''); setSaved(false)
    cccIntegration('get_ccc_policy', { organizationId }).then(result => {
      if (active) { setData(result); setForm({...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})}) }
    }).catch(error => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [organizationId])
  async function save(event) {
    if (form.provider === 'nehfams' && data.policy.provider === 'nehfams' && data.policy.environment === (form.environment || 'production') && !connectionDirty) {
      event.preventDefault(); setSaved(true); setMessage('Connection unchanged. Current validation and generation status have been retained.'); return
    }
    event.preventDefault(); setBusy(true); setOperation('save'); setMessage(''); setSaved(false)
    try {
      const result = await cccIntegration('save_ccc_policy', { organizationId, provider: form.provider, enabled: form.provider==='nehfams'?false:form.enabled,
        environment: form.environment || 'production', expectedHpn: form.expectedHpn, expectedFacilityName: form.expectedFacilityName, bearerToken: form.provider === 'otac' ? token : '',
        ...(form.provider === 'nehfams' ? { nehfamsApiKey: apiKey, nehfamsApiSecret: apiSecret } : {}) })
      setData(result); setForm({...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})}); setToken(''); setApiKey(''); setApiSecret(''); setSaved(true); setMessage('')
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  async function connectionAction(action) {
    if (connectionDirty) { setMessage('Save the changed connection details before validation or activation.'); return }
    setBusy(true); setOperation(action); setSaved(false); setMessage('')
    try {
      const result=await cccIntegration(action,{organizationId,environment:form.environment || 'production'})
      setData(result);setForm(current => action === 'validate_nehfams_connection' ? current : {...result.policy,...(result.policy.provider==='nehfams' && result.policy.nehfams ? {expectedHpn:result.policy.nehfams.expectedHpn,expectedFacilityName:result.policy.nehfams.expectedFacilityName} : {})})
    } catch(error) {setMessage(error.message)} finally {setBusy(false)}
  }
  const selectedConnection=data?.nehfamsConnections?.find(c=>c.environment===(form?.environment || 'production'))
  const connectionDirty = !selectedConnection || !!apiKey || !!apiSecret ||
    (form?.expectedHpn || '').trim() !== (selectedConnection.expectedHpn || '') ||
    (form?.expectedFacilityName || '').trim() !== (selectedConnection.expectedFacilityName || '')
  const nehfamsActive = data?.policy.provider === 'nehfams' && data.policy.enabled &&
    data.policy.environment === (form?.environment || 'production')
  const providerNames = {existing:'Existing NHIA API',otac:'NHIA OTAC (Bearer token)',nehfams:'NHIA NeHFAMS / OTAC'}
  function selectProvider(provider) {
    setToken(''); setApiKey(''); setApiSecret(''); setMessage('')
    const connection = provider === 'nehfams' ? selectedConnection : null
    setForm({ ...form, provider,
      enabled: provider === data.policy.provider ? data.policy.enabled : false,
      expectedHpn: connection?.expectedHpn ?? data.policy.expectedHpn ?? '',
      expectedFacilityName: connection?.expectedFacilityName ?? data.policy.expectedFacilityName ?? '',
    })
  }
  const statusLabels = { test_configured: 'NeHFAMS test enabled', production_configured: 'NeHFAMS production enabled', validation_pending: 'NeHFAMS validation pending', disabled: 'Generation paused', existing_configuration: 'Existing provider', needs_token: 'Token required', needs_renewal: 'Token renewal needed', configured: 'OTAC configured' }
  return <section className="ccc-settings" aria-label="CCC integration">
    <header className="ccc-header">
      <div><span className="ccc-eyebrow">NHIA CONNECTION</span><h3>CCC integration</h3><p>Choose how this facility generates its CCCs.</p></div>
      {data && <span className="ccc-status">{statusLabels[data.policy.status] || 'Review configuration'}</span>}
    </header>
    {data && <p className="ccc-current" role="status">Currently saved: <strong>{providerNames[data.policy.provider]}</strong> · {data.policy.enabled ? 'CCC generation enabled' : 'CCC generation paused'}</p>}
    {message && form?.provider !== 'nehfams' && <p className="ccc-message" role="alert">{message}</p>}
    {!form && !message && <p role="status">Loading connection settings...</p>}
    {form && <form onSubmit={save} onChange={() => {editRevision.current += 1; setSaved(false)}}>
      <fieldset className="ccc-providers" disabled={busy}>
        <legend>1. Choose a provider</legend>
        {[['existing', 'Existing NHIA API', 'Continue using the existing API configuration.'], ['otac', 'NHIA OTAC (Bearer token)', 'Connect with an authorized facility Bearer token.'], ['nehfams', 'NHIA NeHFAMS / OTAC', 'Use this facility\'s API key and secret after connection validation and activation.']].map(([value, title, description]) =>
          <label key={value} className={`ccc-provider ${form.provider === value ? 'selected' : ''}`}>
            <input type="radio" name={`ccc-provider-${organizationId}`} value={value} checked={form.provider === value} onChange={() => selectProvider(value)} />
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
        <h4>2. Connection details</h4>
        <button type="button" disabled={busy || !!apiKey !== !!apiSecret} onClick={fillFacility}>{busy && operation==='discover' ? 'Getting facility details...' : 'Get facility details from NHIA'}</button>
        <p>Automatically fill the HPN and registered name using entered credentials, or the saved credentials when both fields are blank.</p>
        <p>Use this facility's NHIA credentials. Saved credentials can be left blank.</p>
        <label>Environment<select value={form.environment || 'production'} onChange={e=>{setApiKey('');setApiSecret('');setForm({...form,environment:e.target.value,enabled:false,expectedHpn:data?.nehfamsConnections?.find(c=>c.environment===e.target.value)?.expectedHpn || '',expectedFacilityName:data?.nehfamsConnections?.find(c=>c.environment===e.target.value)?.expectedFacilityName || ''})}}><option value="test">NHIA test</option><option value="production">NHIA production</option></select></label>
        <label>Expected facility HPN<input required value={form.expectedHpn || ''} onChange={e=>setForm({...form,expectedHpn:e.target.value})}/></label>
        <label>Expected facility name<input required value={form.expectedFacilityName || ''} onChange={e=>setForm({...form,expectedFacilityName:e.target.value})}/></label>
        <p>Server: {form.environment==='test'?'https://elig.nhia.gov.gh:5007':'https://nehfams.nhia.gov.gh'}</p>
        <label>NeHFAMS API key<input type="password" autoComplete="new-password" required={!selectedConnection && !(form.environment!=='test' && data?.nehfamsReusableCredentials)} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={selectedConnection ? 'Leave blank to retain saved key' : (form.environment!=='test' && data?.nehfamsReusableCredentials) ? 'Saved facility API key will be reused' : 'Facility API key'} /></label>
        <label>NeHFAMS API secret<input type="password" autoComplete="new-password" required={!selectedConnection && !(form.environment!=='test' && data?.nehfamsReusableCredentials)} value={apiSecret} onChange={e => setApiSecret(e.target.value)} placeholder={selectedConnection ? 'Leave blank to retain saved secret' : (form.environment!=='test' && data?.nehfamsReusableCredentials) ? 'Saved facility API secret will be reused' : 'Facility API secret'} /></label>
        <p>{selectedConnection ? 'NeHFAMS credentials are saved separately.' : (form.environment!=='test' && data?.nehfamsReusableCredentials) ? 'Your saved facility API key and secret will be reused when you save. Leave both fields blank; enter both only to use different credentials.' : 'No NeHFAMS credentials saved.'} Existing NHIA and Bearer-token OTAC credentials are retained.</p>

        <button type="submit" disabled={busy}>{busy && operation === 'save' ? 'Saving...' : saved ? 'Saved' : 'Save CCC settings'}</button>
        {saved && <p role="status">{nehfamsActive && !connectionDirty ? 'Connection unchanged. CCC generation remains enabled.' : 'Connection details saved. Continue with validation and enable attendance below.'}</p>}
        <h4>3. Validate and enable</h4>
        {message && <p className="ccc-message" role="alert">{message}</p>}
        {connectionDirty && <p>Save the changed connection details before validation or activation.</p>}
        {selectedConnection && !selectedConnection.validated && <p>Validate the saved connection successfully before enabling attendance.</p>}
        {selectedConnection?.validated && !(form.environment === 'test' ? data?.nehfamsTestEnabled : data?.nehfamsProductionEnabled) && <p>Attendance is disabled for this environment on the server.</p>}
        <button type="button" disabled={busy || connectionDirty} onClick={()=>connectionAction('validate_nehfams_connection')}>{busy && operation === 'validate_nehfams_connection' ? 'Validating connection...' : 'Validate saved connection'}</button>
        {selectedConnection?.validated && <p>Validated {selectedConnection.expectedFacilityName}: {selectedConnection.authMode}. OTAC {selectedConnection.otacRequired?'required':'not required'}.</p>}
        {form.environment==='test' && <button type="button" disabled={busy || connectionDirty || !selectedConnection?.validated || !data?.nehfamsTestEnabled} onClick={()=>connectionAction('activate_nehfams_test')}>Enable authorized test attendance</button>}
        {form.environment==='production' && <p>{data?.nehfamsProductionApproval?.routineEnabled ? (data.policy.provider==='nehfams' && data.policy.environment==='production' && data.policy.enabled ? 'Routine production attendance is enabled for this facility.' : 'Routine production is approved. Activate the validated connection to enable attendance.') : data?.nehfamsProductionApproval ? `Approved production attendances remaining: ${data.nehfamsProductionApproval.remaining} of ${data.nehfamsProductionApproval.limit}.` : 'Production NeHFAMS is not approved for this facility.'}</p>}
        {form.environment==='production' && <button type="button" disabled={busy || connectionDirty || !selectedConnection?.validated || !data?.nehfamsProductionEnabled} onClick={()=>connectionAction('activate_nehfams_production')}>{busy && operation === 'activate_nehfams_production' ? 'Enabling attendance...' : 'Enable routine production attendance'}</button>}
        <p role="status">{nehfamsActive && !connectionDirty ? 'Ready. Staff can generate CCCs with NeHFAMS. No further save is needed.' : 'Save details, validate the connection, then enable attendance. Changed details pause generation until validated and enabled again.'}</p>
      </div>}
      {form.provider !== 'nehfams' && <div className="ccc-enable"><label><input type="checkbox" disabled={busy} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> <span><strong>Enable CCC generation</strong><small>Allow staff to generate codes using the selected provider.</small></span></label></div>}
      <footer className="ccc-footer"><p>Unresolved attendance must be checked with NHIA before switching providers.</p>{form.provider !== 'nehfams' && <button type="submit" disabled={busy}>{busy && operation === 'save' ? 'Saving...' : saved ? 'Saved' : 'Save CCC settings'}</button>}</footer>
      <div aria-live="polite" aria-atomic="true">{saved && form.provider !== 'nehfams' && <p className="ccc-save-success" role="status">CCC settings saved successfully. Your facility configuration has been updated.</p>}</div>
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
