// Pure helpers for the report bundle: reading past the 1,000-row page without losing track of whether
// anything was left out, and shaping the two records that feed the export-history and CC code reports.

export const REPORT_PAGE_SIZE = 1000

type QueryResult = { data: unknown[] | null; error: unknown }
type RangedQuery = { range: (from: number, to: number) => PromiseLike<QueryResult> }

/**
 * Reads a query page by page up to `cap` rows. One extra row is asked for, so `truncated` is true only when
 * there really is more than the cap. `createQuery` must return a fresh query, ordered on a unique column
 * last so that no row is skipped or repeated between pages.
 */
export const fetchCappedRows = async (
  createQuery: () => RangedQuery,
  cap: number,
  pageSize: number = REPORT_PAGE_SIZE
) => {
  const rows: Record<string, unknown>[] = []

  for (let from = 0; from <= cap; from += pageSize) {
    const to = Math.min(from + pageSize - 1, cap)
    const { data, error } = await createQuery().range(from, to)
    if (error) return { data: null, error, truncated: false }
    const page = (data || []) as Record<string, unknown>[]
    rows.push(...page)
    if (page.length < to - from + 1) break
  }

  return { data: rows.slice(0, cap), error: null, truncated: rows.length > cap }
}

const asText = (value: unknown) => String(value ?? '').trim()

/** One CLAIM-it (CXF) export, as recorded when the export is completed. Amounts are not recorded. */
export const mapExportAlertToHistory = (row: Record<string, unknown>) => {
  const claimMonth = asText(row.period).slice(0, 7)
  return {
    id: row.id,
    batch_number: asText(row.artifact_sha256).slice(0, 12),
    status: 'exported',
    export_format: 'CXF',
    claim_count: Number(row.claim_count || 0),
    total_amount: null,
    file_name: '',
    created_at: row.created_at,
    branch_name: '-',
    error_message: claimMonth ? `Claim month ${claimMonth}` : '',
  }
}

/** One CC code request. The member number is left out: the report is about who asked, when, and the outcome. */
export const mapCccRequestToLog = (row: Record<string, unknown>) => {
  const actor = row.users as Record<string, unknown> | null | undefined
  const branch = row.branches as Record<string, unknown> | null | undefined
  return {
    id: row.id,
    action: 'cc_code.generate',
    status: asText(row.status),
    createdAt: row.created_at,
    userId: asText(actor?.full_name) || asText(row.actor_id),
    branch_name: asText(branch?.name) || '-',
    errorMessage: asText(row.error_code),
  }
}
