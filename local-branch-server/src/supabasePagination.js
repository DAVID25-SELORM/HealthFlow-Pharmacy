export const DEFAULT_SUPABASE_PAGE_SIZE = 1000

export const streamSupabasePages = async ({
  createQuery,
  onPage,
  pageSize = DEFAULT_SUPABASE_PAGE_SIZE,
}) => {
  const normalizedPageSize = Math.max(1, Math.floor(Number(pageSize) || DEFAULT_SUPABASE_PAGE_SIZE))
  let cursor = null
  let total = 0
  let pages = 0

  while (true) {
    let query = createQuery().order('id', { ascending: true }).limit(normalizedPageSize)
    if (cursor) {
      query = query.gt('id', cursor)
    }

    const { data, error } = await query
    if (error) {
      throw error
    }

    const page = data || []
    if (!page.length) {
      break
    }

    const nextCursor = page.at(-1)?.id
    if (!nextCursor || nextCursor === cursor) {
      throw new Error('Supabase pagination requires a unique, non-empty id on every row.')
    }

    await onPage(page)
    total += page.length
    pages += 1
    cursor = nextCursor

    if (page.length < normalizedPageSize) {
      break
    }
  }

  return { total, pages, cursor }
}
