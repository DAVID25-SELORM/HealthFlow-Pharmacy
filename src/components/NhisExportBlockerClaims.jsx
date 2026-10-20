import { useState } from 'react'

const PAGE_SIZE = 25

export default function NhisExportBlockerClaims({ issue, onView, onEdit }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const claims = Array.isArray(issue.readinessIssues) && issue.readinessIssues.length
    ? issue.readinessIssues
    : Array.isArray(issue.claims) ? issue.claims : []
  if (!claims.length) return null
  const query = search.trim().toLowerCase()
  const filtered = claims.filter(claim => [
    claim.claim_number, claim.patientName, claim.surname, claim.other_names,
    claim.member_no, claim.memberNo, claim.hin, claim.folder_no,
    ...(Array.isArray(claim.issues) ? claim.issues : []),
  ].filter(Boolean).join(' ').toLowerCase().includes(query))
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1))
  const start = currentPage * PAGE_SIZE
  return (
    <details>
      <summary>Review affected claims ({claims.length})</summary>
      {issue.total > claims.length && <p role="status">Only {claims.length} of {issue.total} claims are available. Run the export check again to refresh the list.</p>}
      <label>
        Search {issue.title || 'affected claims'}
        <input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} />
      </label>
      <p aria-live="polite">{filtered.length ? `${start + 1}-${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} claims` : 'No matching claims.'}</p>
      <div className="duplicate-claim-table-wrap">
        <table className="nhis-table readiness-claim-table">
          <thead><tr><th>Claim</th><th>Patient</th><th>Issues to fix</th><th>Actions</th></tr></thead>
          <tbody>{filtered.slice(start, start + PAGE_SIZE).map((claim, index) => {
            const name = claim.patientName || [claim.surname, claim.other_names].filter(Boolean).join(' ') || 'Unknown'
            const label = claim.claim_number || name
            const reasons = Array.isArray(claim.issues) && claim.issues.length ? claim.issues : [issue.message]
            return <tr key={claim.id || `${label}-${index}`}>
              <td>{claim.claim_number || 'Unnumbered'}</td>
              <td>{name}<small>Member/HIN: {claim.member_no || claim.memberNo || claim.hin || '-'}</small></td>
              <td><ul>{reasons.filter(Boolean).map((reason, i) => <li key={i}>{reason}</li>)}</ul></td>
              <td>
                <button type="button" className="btn btn-secondary" disabled={!claim.id} aria-label={`View claim ${label}`} onClick={() => onView({ ...claim, _summaryOnly: true })}>View</button>
                <button type="button" className="btn btn-secondary" disabled={!claim.id} aria-label={`Edit claim ${label}`} onClick={() => onEdit({ ...claim, _summaryOnly: true })}>Edit</button>
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>
      {filtered.length > PAGE_SIZE && <div>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous claims</button>
        <button type="button" disabled={start + PAGE_SIZE >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next claims</button>
      </div>}
    </details>
  )
}
