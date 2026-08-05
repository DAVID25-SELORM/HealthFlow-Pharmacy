import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, from } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: { rpc, from },
}))

import { getDeletedRecords } from './recycleBinService'

const resolvedQuery = (result) => {
  const query = Promise.resolve(result)
  query.abortSignal = vi.fn(() => query)
  return query
}

describe('recycleBinService', () => {
  beforeEach(() => {
    rpc.mockReset()
    from.mockReset()
  })

  it('loads lightweight deleted-record summaries through the scoped RPC', async () => {
    const rows = [{
      id: 'deleted-1',
      entity_type: 'nhis_claim',
      display_name: 'NHIS-000001',
      deleted_at: '2026-08-04T10:00:00Z',
      snapshot: { record: { surname: 'Mensah' } },
    }]
    rpc.mockReturnValue(resolvedQuery({ data: rows, error: null }))

    await expect(getDeletedRecords()).resolves.toEqual(rows)
    expect(rpc).toHaveBeenCalledWith('get_deleted_records_summary')
    expect(from).not.toHaveBeenCalled()
  })

  it('uses an explicit lightweight fallback while the RPC migration is rolling out', async () => {
    rpc.mockReturnValue(resolvedQuery({
      data: null,
      error: { code: 'PGRST202', message: 'Function not found' },
    }))
    const fallback = resolvedQuery({
      data: [{ id: 'deleted-2', display_name: 'Item' }],
      error: null,
    })
    fallback.select = vi.fn(() => fallback)
    fallback.order = vi.fn(() => fallback)
    from.mockReturnValue(fallback)

    await expect(getDeletedRecords()).resolves.toEqual([{ id: 'deleted-2', display_name: 'Item' }])
    expect(from).toHaveBeenCalledWith('deleted_records')
    expect(fallback.select).toHaveBeenCalledWith('id,entity_type,display_name,deleted_at')
    expect(fallback.order).toHaveBeenCalledWith('deleted_at', { ascending: false })
  })

  it('surfaces non-migration errors', async () => {
    rpc.mockReturnValue(resolvedQuery({
      data: null,
      error: { code: '42501', message: 'Permission denied' },
    }))

    await expect(getDeletedRecords()).rejects.toMatchObject({
      code: '42501',
      message: 'Permission denied',
    })
  })
})
