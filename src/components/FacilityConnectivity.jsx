import { useEffect, useRef, useState } from 'react'
import { getFacilityConnectivity } from '../services/facilityConnectivityService'
import './FacilityConnectivity.css'

const statuses = { ONLINE: 'Online', RECENTLY_ACTIVE: 'Recently Active', ATTENTION_REQUIRED: 'Attention Required', OFFLINE: 'Offline', NEVER_CONNECTED: 'Never Connected' }

const time = (value) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Africa/Accra' }) : 'Not yet observed'

export default function FacilityConnectivity() {
  const [filter, setFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [snapshot, setSnapshot] = useState(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [age, setAge] = useState(0)
  const receivedAt = useRef(0)
  const refresh = useRef(() => {})
  useEffect(() => {
    let disposed = false
    let running = false
    const load = async () => {
      if (running || disposed) return
      running = true
      setLoading(true)
      try {
        const next = await getFacilityConnectivity()
        if (!disposed) {
          setSnapshot(next)
          setFailed(false)
          receivedAt.current = Date.now()
          setAge(0)
        }
      } catch {
        if (!disposed) setFailed(true)
      } finally {
        running = false
        if (!disposed) setLoading(false)
      }
    }
    refresh.current = load
    void load()
    const onVisible = () => {
      setAge(Date.now() - receivedAt.current)
      if (document.visibilityState !== 'hidden') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => {
      setAge(Date.now() - receivedAt.current)
      if (document.visibilityState !== 'hidden') void load()
    }, 30000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const stale = failed || age > 90000
  const facilities = snapshot?.facilities || []
  const filtered = facilities.filter((facility) => (filter === 'ALL' || facility.connectivityStatus === filter) && facility.name.toLowerCase().includes(search.trim().toLowerCase()))
  return <section className="platform-section facility-connectivity" aria-label="Facility Connectivity">
    <div className="platform-section-header">
      <div><h2>Facility Connectivity</h2><p>Recent verified contact, separate from account status.</p></div>
      <button className="btn btn-outline" disabled={loading} onClick={() => void refresh.current()}>{loading ? 'Checking connections...' : 'Refresh connections'}</button>
    </div>
    <p>Online means a verified browser heartbeat within 3 minutes or branch-server contact within 15 minutes. Recently Active means contact within 30 minutes. Attention Required means older contact with a registered branch server. Status is connection evidence, not proof of staff activity or continuous connectivity.</p>
    {stale && <p role="alert">Connection status unavailable. {snapshot ? 'The previous observations below are stale.' : 'The connectivity database update may be pending, or the connection could not be checked.'}</p>}
    {snapshot && <>
      <p>Last checked: {time(snapshot.checkedAt)} (Ghana time)</p>
      <div className="facility-connectivity-summary" aria-label="Connection totals">
        {Object.entries(statuses).map(([key, label]) => <span key={key}>{label}: {stale ? 'Unknown' : facilities.filter((facility) => facility.connectivityStatus === key).length}</span>)}
      </div>
      <label>Search facilities <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="facility-connectivity-filters" aria-label="Filter connection status">
        {Object.entries({ ALL: 'All', ...statuses }).map(([key, label]) => <button key={key} className="btn btn-outline" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
      </div>
      <div className="facility-connectivity-table"><table>
        <thead><tr><th>Facility</th><th>Connection evidence</th><th>Staff / sessions reporting</th><th>Last facility contact (Ghana time)</th><th>Last browser contact</th><th>Branch servers</th><th>Last server contact</th><th>Account</th></tr></thead>
        <tbody>{filtered.map((facility) => {
          return <tr key={facility.id}>
            <th scope="row">{facility.name}</th>
            <td>{stale ? 'Unknown — stale view' : statuses[facility.connectivityStatus]}</td>
            <td>{stale ? '—' : `${facility.recentStaff} staff / ${facility.recentSessions} sessions`}</td>
            <td>{time(facility.lastSeen)}</td>
            <td>{time(facility.lastBrowserContact)}</td>
            <td>{stale ? '—' : `${facility.recentServers} recent / ${facility.registeredServers} registered`}</td>
            <td>{facility.lastServerContact ? time(facility.lastServerContact) : Number(facility.registeredServers) === 0 ? 'No branch server registered' : 'Awaiting first server contact'}</td><td>{facility.accountStatus}</td>
          </tr>
        })}</tbody>
      </table></div>
      {!filtered.length && <p>{facilities.length ? 'No facilities match your search and filter.' : 'No facilities found.'}</p>}
    </>}
    <p>No recent contact can mean a closed browser, sleeping computer or lost internet. Older app versions do not send browser contact. Sessions may remain recent for up to 3 minutes after sign-out.</p>
  </section>
}
