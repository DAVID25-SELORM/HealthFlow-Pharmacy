// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: mock }))
import { allowedSearchSources, searchFacilityRecords, searchSources } from './generalSearchService'
let query
beforeEach(() => {
  query = { select: vi.fn(), eq: vi.fn(), or: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(), then: (resolve) => Promise.resolve({ data: [{ id: 'claim1', ccc_no: '28058' }], error: null }).then(resolve) }
  for (const key of ['select', 'eq', 'or', 'order', 'limit', 'abortSignal']) query[key].mockReturnValue(query)
  mock.from.mockReset().mockReturnValue(query)
})
it('searches CCC across dates but always scopes the facility and bounds results', async () => {
  const result = await searchFacilityRecords({ term: '28058', organizationId: 'facility1', sources: [searchSources[0]] })
  expect(mock.from).toHaveBeenCalledWith('nhis_claims')
  expect(query.eq).toHaveBeenCalledWith('organization_id', 'facility1')
  expect(query.or.mock.calls[0][0]).toContain('ccc_no.ilike.%28058%')
  expect(query.limit).toHaveBeenCalledWith(26)
  expect(result[0].rows[0].ccc_no).toBe('28058')
})
it('does not query without a facility or a meaningful search term', async () => {
  await searchFacilityRecords({ term: '28058', sources: searchSources })
  await searchFacilityRecords({ term: '%,()', organizationId: 'org', sources: searchSources })
  expect(mock.from).not.toHaveBeenCalled()
})
it('does not expose modules unavailable to the active role or plan', () => {
  const result = allowedSearchSources({ role: 'cashier' }, { canUseNhis: true, canUsePurchases: false, organization: {} })
  expect(result.map((s) => s.key)).toEqual(['sales'])
  expect(allowedSearchSources({ role: 'admin' }, { canUseNhis: true, organization: { organization_type: 'chemical_shop' } }).some((s) => s.key === 'nhis')).toBe(false)
})
it('reports module failures separately from empty results', async () => {
  query.then = (resolve) => Promise.resolve({ error: { message: 'Permission denied' } }).then(resolve)
  const result = await searchFacilityRecords({ term: '28058', organizationId: 'org', sources: [searchSources[0]] })
  expect(result[0].error).toBe('Permission denied')
})
