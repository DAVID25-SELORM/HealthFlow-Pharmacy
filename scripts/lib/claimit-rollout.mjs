export const PRODUCTION_REF = 'bcvmiwmhtvtqrvzdovin'

export function assertTarget(url, expectedRef, apply) {
  const parsed = new URL(url)
  if (!/^[a-z]{20}$/.test(expectedRef || '') || parsed.protocol !== 'https:' ||
      parsed.hostname !== `${expectedRef}.supabase.co` || parsed.username || parsed.password ||
      parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Explicit project reference and exact HTTPS Supabase URL must match.')
  }
  if (apply && expectedRef === PRODUCTION_REF) {
    throw new Error('Production writes are locked: staging acceptance and recovery evidence must be reviewed first.')
  }
}

export async function collectAudit(rpc) {
  const counts = { scanned: 0, repairable: 0, unchanged: 0, manual_review_required: 0, errors: 0 }
  const rows = []
  const seen = new Set()
  let after = null
  for (;;) {
    const page = await rpc('audit_nhis_claimit', { p_after: after, p_limit: 100, p_apply: false })
    if (!Array.isArray(page?.rows) || page.scanned !== page.rows.length || page.errors !== 0) {
      throw new Error('Incomplete or errored dry-run; remediation is forbidden.')
    }
    for (const row of page.rows) {
      if (!row.id || seen.has(row.id) || !Array.isArray(row.issues) || !row.fingerprint || typeof row.repairable !== 'boolean') {
        throw new Error('Invalid/repeated audit row; remediation is forbidden.')
      }
      seen.add(row.id)
      // Do not copy claim numbers, names, member identifiers, or clinical data.
      rows.push({ id: row.id, fingerprint: row.fingerprint, repairable: row.repairable, issues: row.issues })
      counts.scanned++
      if (row.repairable) counts.repairable++
      if (!row.issues.length) counts.unchanged++
      // This overlaps repairable when non-total issues still need human review.
      if (row.issues.some((issue) => issue !== 'INVALID_TOTALS' || !row.repairable)) counts.manual_review_required++
    }
    if (page.scanned < 100) break
    if (!page.next_cursor || page.next_cursor === after) throw new Error('Audit cursor did not advance.')
    after = page.next_cursor
  }
  return { counts, rows }
}

export async function applyPreview(rpc, preview, current) {
  if (preview.counts.errors !== 0 || JSON.stringify(preview.rows) !== JSON.stringify(current.rows)) {
    throw new Error('Dry-run has errors or changed since review. Generate and review a new dry-run.')
  }
  const counts = { repaired: 0, unchanged: 0, errors: 0 }
  for (const row of preview.rows.filter((row) => row.repairable)) {
    // Server repeats authorization, fingerprint, history, and exact arithmetic checks.
    const result = await rpc('repair_nhis_claimit_total', {
      p_claim_id: row.id, p_expected_fingerprint: row.fingerprint,
    })
    if (result?.changed === true) counts.repaired++
    else if (result?.changed === false) counts.unchanged++
    else throw new Error('Repair returned no result; stop and reconcile before retrying.')
  }
  return counts
}
