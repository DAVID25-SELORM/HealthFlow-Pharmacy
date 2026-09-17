import { useEffect, useId, useState } from 'react'
import { searchPrescribingDirectory } from '../services/prescribingDirectoryService'
import './PrescribingFacilityPicker.css'

export default function PrescribingFacilityPicker({ value = '', facilityId = '', onSelect, onManualChange, privateOptions = [], nhis = false }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState(!facilityId && Boolean(value))
  const [rows, setRows] = useState([])
  const [nhisOnly, setNhisOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const result = await searchPrescribingDirectory({ search: query, nhisOnly })
        if (!cancelled) { setRows(result); setActive(0) }
      } catch (err) {
        if (!cancelled) { setRows([]); setError(err.message || 'Unable to load directory.') }
      } finally { if (!cancelled) setLoading(false) }
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, nhisOnly, open])
  const matches = privateOptions.filter(f => !f.is_shared && f.status !== 'inactive' && (!nhisOnly || f.nhis_enabled === true) &&
    [f.facility_name, ...(f.aliases || []), f.area].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const options = [...rows, ...matches].filter((f, i, all) => all.findIndex(x => x.id === f.id) === i).slice(0, 30)
  const choose = facility => { onSelect(facility); setManual(false); setOpen(false); setQuery('') }
  return <div className="prescribing-picker">
    <label htmlFor={id}>Prescribing Facility</label>
    {value && <div className="prescribing-selection">{value}{facilityId ? ' (selected)' : ' (unlisted)'}</div>}
    <input id={id} className="form-input" role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={`${id}-list`} aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
      value={query} placeholder="Search name, alias or area" onFocus={() => setOpen(true)}
      onChange={e => { setQuery(e.target.value); setRows([]); setOpen(true) }}
      onKeyDown={e => {
        if (e.key === 'Escape') setOpen(false)
        if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, options.length - 1)) }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
        if (e.key === 'Enter') { e.preventDefault(); if (open && options[active]) choose(options[active]) }
      }} />
    {nhis && <label className="prescribing-filter"><input type="checkbox" checked={nhisOnly} onChange={e => { setNhisOnly(e.target.checked); setRows([]) }} />Verified NHIS-enabled facilities only</label>}
    {open && <>
      {loading && <div role="status">Searching...</div>}
      {error && <div role="alert">{error} You can enter an unlisted facility below.</div>}
      <ul id={`${id}-list`} role="listbox" aria-label="Prescribing facilities">
        {options.map((f, i) => <li key={f.id} id={`${id}-${i}`} role="option" aria-selected={active === i}
          onMouseDown={e => e.preventDefault()} onClick={() => choose(f)}>
          <strong>{f.facility_name}{f.aliases?.length ? ` (${f.aliases.join(', ')})` : ''}</strong>
          <small>{[f.area, f.town, f.region, f.is_shared ? (f.nhis_enabled === true ? 'NHIS enabled' : f.nhis_enabled === false ? 'NHIS disabled' : 'NHIS eligibility unverified') : 'Pharmacy register'].filter(Boolean).join(' / ')}</small>
        </li>)}
      </ul>
      {!loading && !error && !options.length && <div>No matching facilities.</div>}
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Close results</button>
    </>}
    <button type="button" className="btn btn-secondary" onClick={() => { setManual(true); setOpen(false); onManualChange(facilityId ? '' : value) }}>Other / Facility not listed</button>
    {(manual || Boolean(value)) && !facilityId && <label>Unlisted facility name<input className="form-input" value={value} onChange={e => onManualChange(e.target.value)} /></label>}
  </div>
}
