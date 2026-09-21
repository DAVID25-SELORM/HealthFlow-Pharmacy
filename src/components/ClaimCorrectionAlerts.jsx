export default function ClaimCorrectionAlerts({ readiness }) {
  const serving = [...new Set(readiness.serving.blockers)]
  const exporting = [...new Set(readiness.export.blockers)]
  const exportOnly = exporting.filter(issue => !serving.includes(issue))
  const warnings = [...new Set(readiness.export.warnings)]
  /** @type {Array<[string, string[]]>} */
  const groups = [
    ['Required for serving and export', serving],
    ['Additional export requirements', exportOnly],
    ['Warnings', warnings],
  ]
  return (
    <section className="claim-correction-alerts" aria-label="Remaining correction alerts">
      <p role="status">
        <strong>Remaining alerts</strong>{' · '}
        Serving Readiness: {serving.length} blockers{' · '}
        Export Readiness: {exporting.length} blockers{' · '}
        Warnings: {warnings.length}
      </p>
      {groups.some(([, issues]) => issues.length > 0) ? (
        <details>
          <summary>View all remaining alerts</summary>
          <div className="claim-correction-alerts__list" tabIndex={0} role="region" aria-label="Correction alert details">
            <p>Export includes serving requirements. Alerts update as you correct the claim.</p>
            {groups.filter(([, issues]) => issues.length > 0).map(([title, issues]) => (
              <div key={title}>
                <strong>{title} ({issues.length})</strong>
                <ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
              </div>
            ))}
          </div>
        </details>
      ) : <span>No remaining readiness alerts.</span>}
    </section>
  )
}
