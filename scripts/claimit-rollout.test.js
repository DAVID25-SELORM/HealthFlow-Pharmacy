// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { assertTarget, collectAudit, applyPreview, PRODUCTION_REF } from './lib/claimit-rollout.mjs'

it('rejects production writes, mismatched refs, and deceptive URLs', () => {
  expect(() => assertTarget(`https://${PRODUCTION_REF}.supabase.co`, PRODUCTION_REF, false)).not.toThrow()
  expect(() => assertTarget(`https://${PRODUCTION_REF}.supabase.co`, PRODUCTION_REF, true)).toThrow('Production writes')
  for (const url of ['http://example.com', `https://${PRODUCTION_REF}.supabase.co.evil.com`, `https://${PRODUCTION_REF}.supabase.co/path`]) {
    expect(() => assertTarget(url, PRODUCTION_REF, false)).toThrow()
  }
})

it('reports overlapping repair and manual-review counts without patient data', async () => {
  const rpc = vi.fn().mockResolvedValue({ scanned: 3, errors: 0, rows: [
    { id: 'a', fingerprint: '1', repairable: true, issues: ['INVALID_TOTALS', 'LEGACY_MISSING_SIGNER'], claimNumber: 'private' },
    { id: 'b', fingerprint: '2', repairable: false, issues: [] },
    { id: 'c', fingerprint: '3', repairable: false, issues: ['INVALID_TOTALS'] },
  ] })
  const report = await collectAudit(rpc)
  expect(report.counts).toEqual({ scanned: 3, repairable: 1, unchanged: 1, manual_review_required: 2, errors: 0 })
  expect(JSON.stringify(report)).not.toContain('private')
  expect(rpc).toHaveBeenCalledWith('audit_nhis_claimit', expect.objectContaining({ p_apply: false }))
})

it('rejects incomplete scans and stale previews before any repair', async () => {
  await expect(collectAudit(vi.fn().mockResolvedValue({ scanned: 1, rows: [], errors: 0 }))).rejects.toThrow('Incomplete')
  const rpc = vi.fn()
  await expect(applyPreview(rpc, { counts: { errors: 0 }, rows: [{ id: 'a' }] }, { rows: [] })).rejects.toThrow('changed')
  expect(rpc).not.toHaveBeenCalled()
})

it('repairs only explicit candidates and never calls signing', async () => {
  const preview = { counts: { errors: 0 }, rows: [
    { id: 'a', fingerprint: '1', repairable: true }, { id: 'b', repairable: false },
  ] }
  const rpc = vi.fn().mockResolvedValue({ changed: true })
  expect(await applyPreview(rpc, preview, preview)).toEqual({ repaired: 1, unchanged: 0, errors: 0 })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('repair_nhis_claimit_total', { p_claim_id: 'a', p_expected_fingerprint: '1' })
})
