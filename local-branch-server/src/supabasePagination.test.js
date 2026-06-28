import { describe, expect, it, vi } from 'vitest'
import { streamSupabasePages } from './supabasePagination.js'

describe('Supabase reference-data pagination', () => {
  it('streams unbounded keyset pages to the importer', async () => {
    const source = Array.from({ length: 2501 }, (_, index) => ({
      id: String(index + 1).padStart(5, '0'),
    }))
    const importedPages = []
    const calls = []

    const createQuery = () => {
      let cursor = ''
      let limit = 1000
      const query = {
        order: vi.fn(() => query),
        limit: vi.fn((value) => {
          limit = value
          return query
        }),
        gt: vi.fn((_column, value) => {
          cursor = value
          return query
        }),
        then: (resolve, reject) => {
          calls.push({ cursor, limit })
          const data = source.filter((row) => row.id > cursor).slice(0, limit)
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
      }
      return query
    }

    const result = await streamSupabasePages({
      createQuery,
      pageSize: 1000,
      onPage: (page) => importedPages.push(page),
    })

    expect(importedPages.flat()).toEqual(source)
    expect(calls).toEqual([
      { cursor: '', limit: 1000 },
      { cursor: '01000', limit: 1000 },
      { cursor: '02000', limit: 1000 },
    ])
    expect(result).toEqual({ total: 2501, pages: 3, cursor: '02501' })
  })

  it('rejects rows that cannot advance the keyset cursor', async () => {
    const query = {
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve, reject) =>
        Promise.resolve({ data: [{ name: 'missing id' }], error: null }).then(resolve, reject),
    }

    await expect(
      streamSupabasePages({
        createQuery: () => query,
        onPage: vi.fn(),
      })
    ).rejects.toThrow('unique, non-empty id')
  })

  it('propagates a page error', async () => {
    const expected = new Error('network failed')
    const query = {
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve, reject) =>
        Promise.resolve({ data: null, error: expected }).then(resolve, reject),
    }

    await expect(
      streamSupabasePages({
        createQuery: () => query,
        onPage: vi.fn(),
      })
    ).rejects.toBe(expected)
  })
})
