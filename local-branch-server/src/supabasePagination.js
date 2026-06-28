export const DEFAULT_SUPABASE_PAGE_SIZE = 1000
export const DEFAULT_SUPABASE_MAX_ROWS = 20000

export const fetchSupabasePages = async ({
  createQuery,
  pageSize = DEFAULT_SUPABASE_PAGE_SIZE,
  maxRows = DEFAULT_SUPABASE_MAX_ROWS,
}) => {
  const normalizedPageSize = Math.max(1, Math.floor(Number(pageSize) || DEFAULT_SUPABASE_PAGE_SIZE))
  const normalizedMaxRows = Math.max(1, Math.floor(Number(maxRows) || DEFAULT_SUPABASE_MAX_ROWS))
  const rows = []

  while (rows.length < normalizedMaxRows) {
    const from = rows.length
    const requested = Math.min(normalizedPageSize, normalizedMaxRows - from)
    const { data, error } = await createQuery().range(from, from + requested - 1)

    if (error) {
      throw error
    }

    const page = data || []
    rows.push(...page)

    if (page.length < requested) {
      break
    }
  }

  return rows
}
