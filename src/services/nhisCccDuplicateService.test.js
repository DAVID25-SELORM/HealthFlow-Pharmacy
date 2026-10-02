// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
vi.mock('./branchServerApi', () => ({ listBranchRecords: vi.fn(), shouldUseBranchServer: vi.fn(() => false) }))
import { supabase } from '../lib/supabase'
import { listBranchRecords } from './branchServerApi'
import { assertNoDuplicateNhisClaimInStore as check } from './nhisCccDuplicateService'
const candidate = { memberNo: '40000001', cccNo: '12345', serviceDate: '2026-10-01', medicines: [{ drug_code: 'A' }] }
const existing = { id: 'existing', member_no: '40000001', ccc_no: '12345', service_date_from: '2026-10-01', status: 'served', medicines: ['A'] }
beforeEach(() => { vi.resetAllMocks(); supabase.rpc.mockResolvedValue({ data: [], error: null }) })
it.each(['admin', 'super_admin', 'claims_officer', 'assistant'])('does not permit a %s override of an exact duplicate', async (role) => {
  supabase.rpc.mockResolvedValue({ data: [existing], error: null })
  const review = vi.fn(async () => true)
  await expect(check({ ...candidate, role, override: true, onCccDuplicateSignal: review })).rejects.toMatchObject({ code: 'NHIS_CCC_DUPLICATE' })
  expect(review).toHaveBeenCalledWith([expect.objectContaining({ severity: 'block' })])
})
it('allows different members sharing a CCC without requiring acknowledgment', async () => {
  supabase.rpc.mockResolvedValue({ data: [{ ...existing, member_no: '90000002' }], error: null })
  await expect(check(candidate)).resolves.toBeUndefined()
})
it('requires review for different CCC, regardless of matching totals, and supplies medicine overlap', async () => {
  supabase.rpc.mockResolvedValue({ data: [{ ...existing, ccc_no: '67890', total_amount: 10 }], error: null })
  await expect(check({ ...candidate, totalAmount: 10 })).rejects.toMatchObject({ code: 'NHIS_CCC_REVIEW_REQUIRED' })
  const review = vi.fn(async () => true)
  await expect(check({ ...candidate, totalAmount: 10, onCccDuplicateSignal: review })).resolves.toBeUndefined()
  expect(review.mock.calls[0][0][0]).toMatchObject({ severity: 'strong_warning', medicineOverlapRatio: 1 })
})
it.each(['2026-10-02', '2026-06-01'])('waits for explicit review for service date %s and respects cancellation', async (date) => {
  supabase.rpc.mockResolvedValue({ data: [{ ...existing, service_date_from: date }], error: null })
  let resolveReview
  const promise = check({ ...candidate, onCccDuplicateSignal: () => new Promise((resolve) => { resolveReview = resolve }) })
  await vi.waitFor(() => expect(resolveReview).toBeTypeOf('function'))
  resolveReview(false)
  await expect(promise).rejects.toMatchObject({ code: 'NHIS_CCC_REVIEW_REQUIRED' })
})
it('continues past the first page to find a blocking duplicate', async () => {
  supabase.rpc.mockResolvedValueOnce({ data: Array.from({ length: 200 }, (_, n) => ({ ...existing, id: String(n), member_no: '99999999' })), error: null })
    .mockResolvedValueOnce({ data: [existing], error: null })
  await expect(check(candidate)).rejects.toMatchObject({ code: 'NHIS_CCC_DUPLICATE' })
  expect(supabase.rpc.mock.calls[1][1].p_offset).toBe(200)
})
it('sends normalized identity, service date and edit exclusion to the facility-scoped lookup', async () => {
  await check({ ...candidate, memberNo: '', hin: '4000-0001', cccNo: 'CC-12345', ignoreClaimId: 'edited' })
  expect(supabase.rpc).toHaveBeenCalledWith('get_nhis_ccc_duplicate_candidates', expect.objectContaining({ p_member: '40000001', p_ccc: '12345', p_service_date: '2026-10-01', p_ignore_id: 'edited' }))
})
it('does not silently save when the lookup fails', async () => {
  supabase.rpc.mockResolvedValue({ data: null, error: new Error('lookup unavailable') })
  await expect(check(candidate)).rejects.toThrow('lookup unavailable')
})
it('uses the same classification for offline saves', async () => {
  listBranchRecords.mockResolvedValue([existing])
  await expect(check({ ...candidate, useBranchServer: true })).rejects.toMatchObject({ code: 'NHIS_CCC_DUPLICATE' })
  expect(supabase.rpc).not.toHaveBeenCalled()
})
it.each(['rejected', 'failed', 'cancelled', 'voided'])('allows reuse after an existing %s claim', async (status) => {
  supabase.rpc.mockResolvedValue({ data: [{ ...existing, status }], error: null })
  await expect(check(candidate)).resolves.toBeUndefined()
})
