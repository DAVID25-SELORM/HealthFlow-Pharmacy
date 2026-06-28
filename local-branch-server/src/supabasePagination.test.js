import { describe, expect, it, vi } from 'vitest'
import { fetchSupabasePages } from './supabasePagination.js'

const createPagedQuery = (allRows) => {
  const range = vi.fn(async (from, to) => ({
    data: allRows.slice(from, to + 1),
    error: null,
  }))

  return {
    createQuery: vi.fn(() => ({ range })),
    range,
  }
}

describe('Supabase reference-data pagination', () => {
  it('loads every page until the final partial page', async () => {
    const source = Array.from({ length: 2501 }, (_, id) => ({ id }))
    const query = createPagedQuery(source)

    const rows = await fetchSupabasePages({
      createQuery: query.createQuery,
      pageSize: 1000,
      maxRows: 20000,
    })

    expect(rows).toEqual(source)
    expect(query.range.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('enforces the configured safety cap', async () => {
    const source = Array.from({ length: 50 }, (_, id) => ({ id }))
    const query = createPagedQuery(source)

    const rows = await fetchSupabasePages({
      createQuery: query.createQuery,
      pageSize: 4,
      maxRows: 10,
    })

    expect(rows).toEqual(source.slice(0, 10))
    expect(query.range.mock.calls.at(-1)).toEqual([8, 9])
  })

  it('propagates a page error without returning partial data', async () => {
    const expected = new Error('network failed')
    const createQuery = () => ({
      range: vi.fn(async () => ({ data: null, error: expected })),
    })

    await expect(fetchSupabasePages({ createQuery })).rejects.toBe(expected)
  })
})
