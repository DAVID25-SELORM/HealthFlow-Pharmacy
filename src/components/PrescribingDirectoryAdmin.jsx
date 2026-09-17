import { useEffect, useState } from 'react'
import { searchPrescribingDirectory, savePrescribingDirectoryEntry } from '../services/prescribingDirectoryService'

const blank = { facility_name: '', aliases: [], area: '', town: '', region: '', facility_type: '', ownership_type: '', nhis_enabled: null, status: 'active' }
export default function PrescribingDirectoryAdmin() {
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [nhisOnly, setNhisOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState([])
  const [entry, setEntry] = useState(null)
  const [aliases, setAliases] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const data = await searchPrescribingDirectory({ search, includeInactive, nhisOnly, offset, administration: true })
        if (!cancelled) { setRows(data); setError('') }
      } catch (err) { if (!cancelled) setError(err.message) }
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [expanded, search, includeInactive, nhisOnly, offset, revision])
  const edit = row => { setEntry({ ...row }); setAliases((row.aliases || []).join(', ')) }
  const save = async e => {
    e.preventDefault(); setBusy(true); setError('')
    try {
      await savePrescribingDirectoryEntry({ ...entry, aliases: aliases.split(',') })
      setEntry(null); setRevision(r => r + 1)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <section className="tenant-create-card">
    <h2>Prescribing Facility Directory</h2>
    <p>Shared prescription-source reference names for all pharmacies. Patient and claim records remain private.</p>
    <button type="button" className="btn btn-secondary" onClick={() => setExpanded(v => !v)}>{expanded ? 'Close directory' : 'Manage directory'}</button>
    {expanded && <>
      <div className="tenant-form-grid">
        <label>Search directory<input className="form-input" value={search} onChange={e => { setSearch(e.target.value); setOffset(0) }} /></label>
        <label><input type="checkbox" checked={includeInactive} onChange={e => { setIncludeInactive(e.target.checked); setOffset(0) }} />Include inactive</label>
        <label><input type="checkbox" checked={nhisOnly} onChange={e => { setNhisOnly(e.target.checked); setOffset(0) }} />NHIS enabled only</label>
        <button type="button" className="btn btn-primary" onClick={() => edit(blank)}>Add directory entry</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {entry && <form onSubmit={save}>
        <div className="tenant-form-grid">
          {[['facility_name', 'Facility name'], ['facility_type', 'Facility type'], ['ownership_type', 'Ownership'], ['area', 'Area'], ['town', 'City / town'], ['region', 'Region']].map(([key, label]) =>
            <label key={key}>{label}<input className="form-input" required={key === 'facility_name'} value={entry[key] || ''} onChange={e => setEntry(v => ({ ...v, [key]: e.target.value }))} /></label>)}
          <label>Aliases (comma separated)<input className="form-input" value={aliases} onChange={e => setAliases(e.target.value)} /></label>
          <label>NHIS eligibility<select className="form-input" value={entry.nhis_enabled === null ? 'unknown' : String(entry.nhis_enabled)} onChange={e => setEntry(v => ({ ...v, nhis_enabled: e.target.value === 'unknown' ? null : e.target.value === 'true' }))}>
            <option value="unknown">Unverified / unknown</option><option value="true">Confirmed enabled</option><option value="false">Confirmed disabled</option>
          </select></label>
          <label>Status<select className="form-input" value={entry.status} onChange={e => setEntry(v => ({ ...v, status: e.target.value }))}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        </div>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save directory entry'}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setEntry(null)} disabled={busy}>Cancel</button>
      </form>}
      <table className="data-table"><thead><tr><th>Facility</th><th>Aliases / area</th><th>NHIS</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}><td>{row.facility_name}</td><td>{[...(row.aliases || []), row.area].filter(Boolean).join(', ')}</td><td>{row.nhis_enabled === true ? 'Enabled' : row.nhis_enabled === false ? 'Disabled' : 'Unverified'}</td><td>{row.status}</td><td><button className="btn btn-secondary" onClick={() => edit(row)}>Edit {row.facility_name}</button></td></tr>)}</tbody>
      </table>
      <button className="btn btn-secondary" disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 30))}>Previous</button>
      <button className="btn btn-secondary" disabled={rows.length < 30} onClick={() => setOffset(v => v + 30)}>Next</button>
    </>}
  </section>
}
