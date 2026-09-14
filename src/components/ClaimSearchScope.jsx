export default function ClaimSearchScope({ search, dateFilter, status, issueFilter, onShowAll }) {
  if (!search.trim()) return null
  const restrictions = [
    dateFilter !== 'all' && 'date',
    status !== 'all' && 'status',
    issueFilter !== 'all' && 'issue',
  ].filter(Boolean)

  return (
    <div className="claim-search-scope" role="note">
      <span>{restrictions.length
        ? `Search is limited by ${restrictions.join(', ')} filters. Older or other visits may be hidden.`
        : 'Searching all dates and statuses within your permitted claims.'}</span>
      {restrictions.length > 0 && (
        <button type="button" className="btn btn-outline" onClick={onShowAll}>
          Search all dates and statuses
        </button>
      )}
    </div>
  )
}
