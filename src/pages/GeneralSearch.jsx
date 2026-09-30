import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTenant } from '../context/TenantContext'
import { supabase } from '../lib/supabase'
import { allowedSearchSources, searchFacilityRecords, searchSources } from '../services/generalSearchService'
import './GeneralSearch.css'

export default function GeneralSearch() {
  const auth = useAuth()
  const tenant = useTenant()
  const sources = allowedSearchSources(auth, tenant)
  const organizationId = tenant.organization?.id || auth.profile?.organization_id
  return <SearchWorkspace key={`${organizationId}:${auth.user?.id}:${sources.map((s) => s.key).join(',')}`}
    organizationId={organizationId} sourceKeys={sources.map((s) => s.key).join(',')} />
}

function SearchWorkspace({ organizationId, sourceKeys }) {
  const sources = useMemo(() => searchSources.filter((s) => sourceKeys.split(',').includes(s.key)), [sourceKeys])
  const [params, setParams] = useSearchParams()
  const term = params.get('search') || ''
  const [input, setInput] = useState(term)
  const [groups, setGroups] = useState([])
  const [branches, setBranches] = useState({})
  const [loading, setLoading] = useState(false)
  useEffect(() => { setInput(term) }, [term])
  useEffect(() => {
    const controller = new AbortController()
    setGroups([])
    if (!organizationId || term.trim().length < 2) { setLoading(false); return () => controller.abort() }
    setLoading(true)
    searchFacilityRecords({ term, organizationId, sources, signal: controller.signal }).then((results) => {
      if (!controller.signal.aborted) { setGroups(results); setLoading(false) }
    })
    supabase.from('branches').select('id,name').eq('organization_id', organizationId).abortSignal(controller.signal)
      .then(({ data }) => { if (!controller.signal.aborted) setBranches(Object.fromEntries((data || []).map((b) => [b.id, b.name]))) })
    return () => controller.abort()
  }, [term, organizationId, sources])
  return <main className="general-search">
    <h1>General search</h1>
    <p>Search CCC, claim and folder numbers, patients, medicines, consumables, suppliers, invoices and sales. Searches all dates and branches you can access in this facility.</p>
    <form onSubmit={(event) => { event.preventDefault(); setParams({ search: input.trim() }) }}>
      <input aria-label="General search" placeholder="Enter a name, CCC, folder or invoice number" value={input} maxLength={120} onChange={(event) => setInput(event.target.value)} />
      <button className="btn btn-primary" type="submit">Search</button>
    </form>
    <p>Available sections: {sources.map((source) => source.label).join(', ') || 'None for your current role'}.</p>
    {loading && <p role="status">Searching...</p>}
    {!loading && term.trim().length < 2 && <p>Enter at least two characters to search.</p>}
    {!loading && groups.length > 0 && groups.every((group) => !group.rows.length && !group.error) && <p role="status">No matching records found.</p>}
    {groups.map((group) => <section key={group.key}>
      <h2>{group.label} ({group.rows.length}{group.more ? '+' : ''})</h2>
      {group.error && <p role="alert">Could not search {group.label.toLowerCase()}: {group.error}</p>}
      {group.more && <p>Showing the first 25 matches. Refine your search for more specific results.</p>}
      <ul>{group.rows.map((row) => <li key={row.id}>
        <strong>{row[group.title] || 'Unnumbered record'}</strong>
        <dl>{[...group.fields, ...group.extra].filter((field) => field !== group.title && row[field] !== null && row[field] !== undefined && row[field] !== '').map((field) =>
          <div key={field}><dt>{field === 'ccc_no' ? 'CCC' : field.replaceAll('_', ' ')}</dt><dd>{field === 'branch_id' ? branches[row[field]] || 'Branch name unavailable' : String(row[field])}</dd></div>
        )}</dl>
        <Link to={group.key === 'nhis' ? `/nhis?claimId=${encodeURIComponent(row.id)}` : `${group.path}?search=${encodeURIComponent(row[group.title] || term)}`}>
          {group.key === 'nhis' ? 'Open claim' : `Go to ${group.label.toLowerCase()}`}
        </Link>
      </li>)}</ul>
    </section>)}
  </main>
}
