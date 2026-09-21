import { beforeEach, expect, it, vi } from 'vitest'
import { supabase } from '../lib/supabase'
import { getExportSigningEvidence, signNhisClaim, auditClaimItClaims, recordCxfExport } from './claimitLifecycleService'

vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())

it('merges only stored signing evidence onto the caller rows and never sends browser signer identity', async () => {
  supabase.rpc.mockResolvedValue({ data: [{ id: 'claim', signed_by_name: 'Authenticated signer', signed_on: '2026-06-01T10:00:00Z', surname: 'SERVER COPY' }], error: null })
  const { claims, warnings } = await getExportSigningEvidence([{ id: 'claim', signed_by_name: 'Forged name', surname: 'Local row', total_amount: 5 }])
  expect(supabase.rpc).toHaveBeenCalledWith('claimit_export_claims', { p_claim_ids: ['claim'], p_reexport_reason: null })
  expect(claims[0].signed_by_name).toBe('Authenticated signer')
  expect(claims[0].signed_on).toBe('2026-06-01T10:00:00Z')
  // Clinical/demographic data stays exactly as the accepted June path read it.
  expect(claims[0]).toMatchObject({ surname: 'Local row', total_amount: 5 })
  expect(warnings).toEqual([])
  supabase.rpc.mockResolvedValue({ data: { id: 'signature' }, error: null })
  await signNhisClaim('claim', 'Reviewed')
  expect(supabase.rpc).toHaveBeenLastCalledWith('sign_nhis_claim', { p_claim_id: 'claim', p_reason: 'Reviewed' })
})

it('never blocks: server errors, incomplete responses and unsigned claims degrade to the legacy path with a warning', async () => {
  const candidates = [{ id: 'claim', surname: 'Legacy' }]
  supabase.rpc.mockResolvedValue({ data: null, error: new Error('anything') })
  expect(await getExportSigningEvidence(candidates)).toEqual({ claims: candidates, warnings: [{ claimNumber: '', warnings: ['SIGNING_EVIDENCE_UNAVAILABLE'] }] })
  supabase.rpc.mockRejectedValue(new Error('function does not exist'))
  expect((await getExportSigningEvidence(candidates)).claims).toEqual(candidates)
  supabase.rpc.mockResolvedValue({ data: [], error: null })
  expect((await getExportSigningEvidence(candidates)).claims).toEqual(candidates)
  supabase.rpc.mockResolvedValue({ data: [{ id: 'claim', signed_by_name: null, signed_on: null }], error: null })
  const unsigned = await getExportSigningEvidence(candidates)
  expect(unsigned.claims[0].signed_by_name).toBeUndefined()
  expect(unsigned.claims[0].signed_on).toBeUndefined()
})

it('defaults to dry-run and batches large signing-evidence lookups', async () => {
  supabase.rpc.mockResolvedValue({ data: { scanned: 0 }, error: null })
  await auditClaimItClaims()
  expect(supabase.rpc.mock.calls[0][1].p_apply).toBe(false)
  supabase.rpc.mockImplementation(async (_name, args) => ({ data: args.p_claim_ids.map((id) => ({ id })), error: null }))
  const candidates = Array.from({ length: 501 }, (_, i) => ({ id: String(i) }))
  expect((await getExportSigningEvidence(candidates)).claims).toHaveLength(501)
  expect(supabase.rpc.mock.calls.slice(1).map((call) => call[1].p_claim_ids.length)).toEqual([500, 1])
})

it('records the artifact hash and expected fingerprints for the audit trail', async () => {
  const { webcrypto } = await import('node:crypto')
  vi.stubGlobal('crypto', webcrypto)
  try {
    supabase.rpc.mockResolvedValue({ data: null, error: null })
    expect(await recordCxfExport([{ id: 'claim', claimit_fingerprint: 'snapshot' }], new Uint8Array([1, 2, 3]), 'Corrected metadata')).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('record_nhis_cxf_export_atomic', expect.objectContaining({
      p_claim_ids: ['claim'], p_fingerprints: { claim: 'snapshot' }, p_reexport_reason: 'Corrected metadata',
      p_artifact_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }))
  } finally { vi.unstubAllGlobals() }
})

it('reports an unrecorded audit as a warning instead of failing the already generated export', async () => {
  const { webcrypto } = await import('node:crypto')
  vi.stubGlobal('crypto', webcrypto)
  try {
    const claims = Array.from({ length: 501 }, (_, i) => ({ id: String(i), claimit_fingerprint: `revision-${i}` }))
    supabase.rpc.mockResolvedValue({ data: null, error: new Error('Last batch rejected') })
    expect(await recordCxfExport(claims, new Uint8Array([1, 2, 3]))).toEqual({ claimNumber: '', warnings: ['EXPORT_AUDIT_NOT_RECORDED'] })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc.mock.calls[0][1].p_claim_ids).toHaveLength(501)
    // Claims with no fingerprint (legacy enrichment unavailable) are audited best-effort too.
    supabase.rpc.mockResolvedValue({ data: null, error: null })
    await recordCxfExport([{ id: 'x' }], new Uint8Array([1]))
    expect(supabase.rpc.mock.calls.at(-1)[1].p_fingerprints).toEqual({ x: null })
  } finally { vi.unstubAllGlobals() }
})

it('skips enrichment for empty, duplicate, or excessive batches without calling the server', async () => {
  const skipped = 'SIGNING_EVIDENCE_SKIPPED_INVALID_BATCH'
  for (const batch of [[], [{ id: 'same' }, { id: 'same' }], Array.from({ length: 10001 }, (_, i) => ({ id: String(i) }))]) {
    const result = await getExportSigningEvidence(batch)
    expect(result.claims).toBe(batch)
    expect(result.warnings[0].warnings).toEqual([skipped])
  }
  expect(supabase.rpc).not.toHaveBeenCalled()
})
