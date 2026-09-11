import { useEffect, useRef, useState } from 'react'
import { getFacilityConnectivity } from '../services/facilityConnectivityService'
import './FacilityConnectivity.css'

const time = (value) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Africa/Accra' }) : 'Not yet observed'

export default function FacilityConnectivity() {
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
  return <section className="platform-section facility-connectivity" aria-label="Facility Connectivity">
    <div className="platform-section-header">
      <div><h2>Facility Connectivity</h2><p>Recent verified contact, separate from account status.</p></div>
      <button className="btn btn-outline" disabled={loading} onClick={() => void refresh.current()}>{loading ? 'Checking connections...' : 'Refresh connections'}</button>
    </div>
    <p>Staff sessions report while HealthFlow is visible. Recent means within 3 minutes for browsers or 15 minutes for branch servers. This does not prove staff activity or a continuous connection.</p>
    {stale && <p role="alert">Connection status unavailable. {snapshot ? 'The previous observations below are stale.' : 'The connectivity database update may be pending, or the connection could not be checked.'}</p>}
    {snapshot && <>
      <p>Last checked: {time(snapshot.checkedAt)} (Ghana time)</p>
      <div className="facility-connectivity-table"><table>
        <thead><tr><th>Facility</th><th>Connection evidence</th><th>Staff / sessions reporting</th><th>Last browser contact</th><th>Branch servers</th><th>Last server contact</th><th>Account</th></tr></thead>
        <tbody>{snapshot.facilities.map((facility) => {
          const recent = Number(facility.recentSessions) > 0 || Number(facility.recentServers) > 0
          const observed = facility.lastBrowserContact || facility.lastServerContact
          return <tr key={facility.id}>
            <th scope="row">{facility.name}</th>
            <td>{stale ? 'Unknown — stale view' : recent ? 'Recent connection' : observed ? 'No recent connection' : 'Not yet observed'}</td>
            <td>{stale ? '—' : `${facility.recentStaff} staff / ${facility.recentSessions} sessions`}</td>
            <td>{time(facility.lastBrowserContact)}</td>
            <td>{stale ? '—' : `${facility.recentServers} recent / ${facility.registeredServers} registered`}</td>
            <td>{time(facility.lastServerContact)}</td><td>{facility.accountStatus}</td>
          </tr>
        })}</tbody>
      </table></div>
      {!snapshot.facilities.length && <p>No facilities found.</p>}
    </>}
    <p>No recent contact can mean a closed browser, sleeping computer or lost internet. Older app versions do not send browser contact. Sessions may remain recent for up to 3 minutes after sign-out.</p>
  </section>
}
