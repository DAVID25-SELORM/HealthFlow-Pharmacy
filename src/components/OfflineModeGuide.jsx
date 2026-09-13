import { useState } from 'react'
import { offlineCheckMessage } from '../utils/offlineModeSummary'

export default function OfflineModeGuide({ summary: s, loading, busy, canManage, canRegister, canInstall, facilityName, branchName, onInstall, onRefresh, onPrepare, onTest, onSync, onAdvanced, onIssues, onWorkstations, onProductionVerification, staff = [], workstations = [], test, preparation, setupFields }) {
  const [setupOpen, setSetupOpen] = useState(false)
  const [staffOpen, setStaffOpen] = useState(false)
  const activeWorkstations = workstations.filter((item) => item.status === 'active')
  const workstationSummary = !s.connected ? 'Status Unknown' : activeWorkstations.length ? `${activeWorkstations.length} authorized` : 'No other computers enrolled'
  return <section className={`offline-guide ${s.ready && s.tested ? 'is-ready' : ''}`} aria-label="Offline Mode overview">
    <div className="offline-guide-title">
      <div><span className="offline-guide-eyebrow">{s.ready ? 'OFFLINE MODE' : 'SET UP → PREPARE → CONNECT STAFF → TEST → READY'}</span>
        <h2>{loading ? 'Checking Offline Mode' : s.setupStatus}</h2>
        <p>{s.ready ? 'Offline Mode is ready. Production verification is a recommended final check.' : 'Keep HealthFlow working when your internet goes down.'}</p></div>
      <strong role="status">{s.dailyStatus}</strong>
    </div>
    <p>Work is saved securely on the Main Computer and synchronized automatically when internet returns.</p>
    {s.dailyStatus === 'Offline — Local Server' && <p className="offline-guide-action-card">Internet is unavailable. HealthFlow is using the facility’s local server. Supported work will be saved locally and synchronized when internet returns.</p>}
    {(s.configured || s.connected) && <dl className="offline-summary-grid">
      <div><dt>Main Computer</dt><dd>{s.connected ? 'Connected' : s.configured ? 'Status Unknown' : 'Not set up'}</dd></div>
      <div><dt>Facility</dt><dd>{facilityName || 'Choose a facility'}{branchName ? ` / ${branchName}` : ''}</dd></div>
      <div><dt>Data</dt><dd>{s.data}</dd></div>
      <div><dt>Staff</dt><dd>{s.staffReady == null ? 'Not checked' : `${s.staffReady} ready`}</dd></div>
      <div><dt>Workstations</dt><dd>{workstationSummary}</dd></div>
      <div><dt>Unsynced Work</dt><dd>{s.connected ? s.pending + s.failed + s.syncing : 'Not checked'}</dd></div>
      <div><dt>Production</dt><dd>{s.productionVerified ? 'Verified' : 'Not yet verified'}</dd></div>
    </dl>}
    <div className="offline-main-actions">
      {!s.identityMatches && canManage && (s.configured && !s.connected ? <button className="btn btn-primary" disabled={loading || Boolean(busy)} onClick={onRefresh}>Check Main Computer</button> : <button className="btn btn-primary" disabled={loading || Boolean(busy)} onClick={() => setSetupOpen(true)}>Set Up Offline Mode</button>)}
      {s.identityMatches && !s.ready && canManage && <button className="btn btn-primary" disabled={loading || Boolean(busy) || !s.connected} onClick={onPrepare}>{busy === 'prepare-offline' ? 'Preparing...' : 'Prepare Offline Mode'}</button>}
      {s.identityMatches && <button className={`btn ${s.ready ? 'btn-primary' : 'btn-outline'}`} disabled={loading || Boolean(busy) || !s.connected} onClick={onTest}>{busy === 'test-offline' ? 'Testing...' : 'Test Offline Mode'}</button>}
      {s.identityMatches && canManage && <button className="btn btn-outline" disabled={loading || Boolean(busy) || !s.connected} onClick={onSync}>Sync Now</button>}
    </div>
    {!canManage && !s.ready && <p>Ask your facility administrator to complete Offline Mode setup.</p>}
    {setupOpen && <section className="offline-guide-panel" aria-label="Set up Offline Mode">
      <h3>1. Main Computer</h3>
      <p>The Main Computer keeps your facility’s offline data. Keep it powered on so other computers on the same Wi-Fi or LAN can use HealthFlow during an internet outage.</p>
      {s.connected ? <p>Main Computer detected. Installation is already complete.</p> : <>
        <p>{s.configured ? 'The configured Main Computer is not reachable. Check its power and your network, then check again.' : 'Open the installed HealthFlow shortcut if this computer already has Offline Mode. Otherwise, download and run the installer on the Main Computer.'}</p>
        {!s.configured && <button className="btn btn-primary" disabled={!canInstall || Boolean(busy)} onClick={onInstall}>Download and Install</button>}
        <button className="btn btn-outline" disabled={loading || Boolean(busy)} onClick={onRefresh}>Check Main Computer</button>
      </>}
      {s.connected && <><h3>2. Connect Facility</h3>
        {s.identityMatches ? <p>{facilityName} / {branchName}: Connected</p> : canRegister ? setupFields : <p>A system administrator must connect this Main Computer to the correct facility and branch.</p>}
        {s.identityMatches && <><h3>3. Prepare Offline Mode</h3><p>HealthFlow safely refreshes the facility’s supported records together. Then connect authorized workstations, prepare staff access and run the safe readiness test.</p></>}
      </>}
    </section>}
    {busy === 'prepare-offline' && <p role="status">{preparation || 'Preparing facility data...'}</p>}
    {s.connected && !s.ready && <div className="offline-readiness-problem">
      {!s.identityMatches && <p>The Main Computer’s facility must match your selected facility and branch.</p>}
      {s.data === 'Needs Refresh' && <p>Offline data needs refreshing. Prepare Offline Mode while internet is available.</p>}
      {s.failedChecks.map((check) => <p key={check.id}>{offlineCheckMessage(check.id)}</p>)}
      {!s.failedChecks.length && s.data === 'Action Required' && <p>Offline data or backup protection needs attention. Ask your administrator to review Advanced.</p>}
      {s.backupNeedsAttention && <p>Local backup protection needs attention. Ask your administrator to review backup status under Advanced.</p>}
      {s.compatibilityBlocked && <p>The Main Computer needs a compatible update. Ask your administrator to review Advanced.</p>}
    </div>}
    {s.connected && <section className="offline-guide-panel">
      <h3>Staff Offline Access</h3>
      <p>{s.staffReady == null ? 'Staff readiness has not been checked.' : `${s.staffReady} Ready${s.staffMissing ? `. ${s.staffMissing} Need PIN` : ''}`}</p>
      {canManage && <button className="btn btn-outline" onClick={() => setStaffOpen(!staffOpen)}>View Staff</button>}
      {staffOpen && <>{staff.filter((item) => item.isActive !== false).map((item) => {
        const locked = item.offlineLockedUntil && new Date(item.offlineLockedUntil) > new Date()
        const state = locked ? 'Attention Required — temporarily locked' : item.offlineAccessEnabled && item.offlinePinEnrolled ? 'Ready' : item.offlineAccessEnabled ? 'PIN Required' : 'Offline Access Off'
        return <p key={item.id}>{item.fullName || item.full_name || item.email}: {state}</p>
      })}<p>For a new staff member: create the account, turn Offline Access on, then have the staff member create their own 6–12 digit PIN. Test with a planned sign-in on an authorized workstation; it does not create a business record.</p><a className="btn btn-outline" href="/settings#offline-access">Manage Staff Access</a></>}
    </section>}
    {s.connected && <section className="offline-guide-panel">
      <h3>Workstations</h3>
      <p>Main Computer: Ready</p>
      <p>Other Workstations: {workstationSummary}</p>
      {canManage && <button className="btn btn-outline" onClick={onWorkstations}>Manage Workstations</button>}
    </section>}
    {s.failed > 0 && <div className="offline-guide-action-card"><p>{s.failed} records need attention before synchronization can finish.</p>{canManage ? <button className="btn btn-primary" onClick={onIssues}>Fix Sync Issues</button> : <p>Ask your administrator to review Sync Issues.</p>}</div>}
    {test && <p role="status">{s.tested && s.ready ? 'Safe readiness test passed. Offline Mode Ready.' : test.message || 'Offline checks need attention. Review the guidance above, then test again.'}</p>}
    {s.productionVerified ? <p className="offline-guide-action-card"><strong>Offline Mode Production Verified</strong><br />A controlled outage, local cash sale, stock reduction, reconnection and clean synchronization have been recorded for this facility.</p> : s.tested && s.ready ? <div className="offline-guide-action-card"><p><strong>Recommended final verification:</strong> Production Verification confirms that this facility can work through a real internet outage and safely synchronize afterward.</p>{canManage && <button className="btn btn-outline" onClick={onProductionVerification}>Run Production Verification</button>}</div> : null}
    <details><summary>Using Other Computers</summary><p>On the same facility Wi-Fi or LAN, use the approved Connect This Computer setup supplied by your administrator. Keep the Main Computer powered on. Connection and enrollment controls are under Advanced.</p></details>
    <details><summary>How to use Offline Mode</summary><ol><li>Set up the Main Computer.</li><li>Prepare Offline Mode.</li><li>Connect approved workstations and prepare staff PINs.</li><li>Run Test Offline Mode.</li><li>When Offline Mode Ready appears, use HealthFlow normally.</li></ol><p>During an outage, open the local HealthFlow app and sign in with your Offline PIN. Supported work saves locally. When internet returns, HealthFlow automatically synchronizes saved work.</p></details>
    <p className="offline-limitations"><strong>Internet required:</strong> Live NHIA/NEHFAMS verification, online payments and other cloud-only services.</p>
    {canManage && <button className="offline-technical-toggle" onClick={onAdvanced} aria-controls="offline-advanced">Advanced / Technical Details</button>}
  </section>
}
