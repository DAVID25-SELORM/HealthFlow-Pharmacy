import { expect, it, vi } from 'vitest'
import { assertNhisUnservedLocalDraft } from '../../local-branch-server/src/nhisOnlineServing.js'
import { createBranchRecord, updateBranchRecord, updateBranchNhisClaimMedicines } from './branchServerApi'

it.each([
  { status: 'served' },
  { status: 'partially_served' },
  { direct_served_at: '2026-10-03' },
  { servingStatus: 'fully_served' },
  { nhis_claim_medicines: [{ served_qty: 1 }] },
  { medicines: [{ servedQty: 1 }] },
])('rejects local completed supply %j', (claim) => {
  expect(() => assertNhisUnservedLocalDraft(claim)).toThrow('online medication coverage check')
})

it('allows pending intake without supplying medicine', () => {
  expect(() => assertNhisUnservedLocalDraft({ status: 'draft', nhis_claim_medicines: [
    { prescribed_qty: 15, served_qty: 0, serving_status: 'pending' },
  ] })).not.toThrow()
})

it('blocks hosted-browser branch serving before any request reaches even an old branch server', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  try {
    await expect(createBranchRecord('nhis/claims', { status: 'served' })).rejects.toThrow('online medication coverage check')
    await expect(updateBranchRecord('nhis/claims', 'claim', { nhis_claim_medicines: [{ served_qty: 1 }] })).rejects.toThrow('online medication coverage check')
    await expect(updateBranchNhisClaimMedicines('claim', {})).rejects.toThrow('online medication coverage check')
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
  }
})
