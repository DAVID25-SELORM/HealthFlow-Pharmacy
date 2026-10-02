import { Link } from 'react-router-dom'

// Omit patient names, raw NHIA responses, and unmasked membership IDs.
export default function NhisCccDuplicateReview({ signals }) {
  return <div className="duplicate-claim-table-wrap">
    {signals.map((signal) => <section key={`${signal.reasonCode}-${signal.claim.id}`}>
      <p>{signal.message}</p>
      <dl>
        <dt>Claim reference</dt><dd>{signal.claim.claimNumber || signal.claim.id}</dd>
        <dt>Service date</dt><dd>{signal.claim.serviceDate || 'Not recorded'}</dd>
        <dt>Member</dt><dd>{signal.claim.memberNo ? `****${signal.claim.memberNo.slice(-4)}` : 'Not recorded'}</dd>
        <dt>Status</dt><dd>{signal.claim.status || 'Not recorded'}</dd>
        <dt>Total</dt><dd>{Number(signal.claim.totalAmount || 0).toFixed(2)}</dd>
        <dt>CCC / CC</dt><dd>{signal.claim.ccc || 'Pending'}</dd>
        <dt>Medicines</dt><dd>{signal.claim.medicines?.join(', ') || 'None recorded'}</dd>
      </dl>
      <Link target="_blank" rel="noopener noreferrer"
        to={`/search?search=${encodeURIComponent(signal.claim.claimNumber || signal.claim.ccc || '')}`}>
        Find existing claim (new tab)
      </Link>
    </section>)}
  </div>
}
