import { beforeEach, expect, it, vi } from 'vitest'
import { supabase } from '../lib/supabase'
import {
  getExportSigningEvidence, signNhisClaim, auditClaimItClaims, recordCxfExport, retryCxfRecording, countUnrecordedClaims,
} from './claimitLifecycleService'

vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())

it('merges only stored signing evidence onto the caller rows and never sends browser signer identity', async () => {
  supabase.rpc.mockResolvedValue({ data: [{ id: 'claim', signed_by_name: 'Authenticated signer', signed_on: '2026-06-01T10:00:00Z', surname: 'SERVER COPY' }], error: null })
  const { claims, warnings } = await getExportSigningEvidence([{ id: 'claim', signed_by_name: 'Forged name', surname: 'Local row', total_amount: 5 }])
  expect(supabase.rpc).toHaveBeenCalledWith('claimit_export_signing_evidence', { p_claim_ids: ['claim'], p_reexport_reason: null })
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
  // 250 per call keeps each RPC inside the database's 8 s statement timeout.
  expect(supabase.rpc.mock.calls.slice(1).map((call) => call[1].p_claim_ids.length)).toEqual([250, 250, 1])
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
    const warning = await recordCxfExport(claims, new Uint8Array([1, 2, 3]), null, { retryDelayMs: 0 })
    expect(warning).toMatchObject({ claimNumber: '', warnings: ['EXPORT_AUDIT_NOT_RECORDED'] })
    // 501 claims are recorded in chunks of 250; every chunk failed (each tried twice), none is reported recorded.
    expect(supabase.rpc.mock.calls.map((call) => call[1].p_claim_ids.length)).toEqual([250, 250, 250, 250, 1, 1])
    expect(countUnrecordedClaims(warning.recording)).toBe(501)
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

const withCrypto = async (run) => {
  const { webcrypto } = await import('node:crypto')
  vi.stubGlobal('crypto', webcrypto)
  try { await run() } finally { vi.unstubAllGlobals() }
}
const makeClaims = (count) => Array.from({ length: count }, (_, i) => ({
  id: `claim-${i}`, organization_id: 'facility-1', claimit_fingerprint: `fp-${i}`, surname: 'PATIENT-NAME', member_no: '12345678',
}))
const rpcCalls = (name) => supabase.rpc.mock.calls.filter((call) => call[0] === name)

it('falls back to the legacy evidence RPC only while the slim RPC is not deployed', async () => {
  supabase.rpc.mockImplementation(async (name, args) => name === 'claimit_export_signing_evidence'
    ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claimit_export_signing_evidence' } }
    : { data: args.p_claim_ids.map((id) => ({ id, signed_by_name: 'Legacy path' })), error: null })
  const { claims, warnings } = await getExportSigningEvidence(makeClaims(3))
  expect(warnings).toEqual([])
  expect(claims.every((claim) => claim.signed_by_name === 'Legacy path')).toBe(true)
  expect(rpcCalls('claimit_export_claims')).toHaveLength(1)
})

it('logs structured, PHI-free diagnostics when the evidence RPC fails, and still lets the export continue', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  supabase.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: 'd', hint: 'h', status: 500 } })
  const candidates = makeClaims(2)
  const result = await getExportSigningEvidence(candidates, { exportRef: 'run-1' })
  expect(result.claims).toBe(candidates)
  expect(result.warnings[0].warnings).toEqual(['SIGNING_EVIDENCE_UNAVAILABLE'])
  const [label, fields] = log.mock.calls[0]
  expect(label).toBe('[CLAIM-it export RPC failed]')
  expect(fields).toMatchObject({ rpc: 'claimit_export_signing_evidence', code: '57014', details: 'd', hint: 'h', status: 500, exportRef: 'run-1', facilityId: 'facility-1', claimCount: 2 })
  expect(JSON.stringify(fields)).not.toMatch(/PATIENT-NAME|12345678|claim-0/)
  log.mockRestore()
})

it('handles a full 3,093-claim export: 13 evidence calls and 13 record calls, all within 250 claims', async () => {
  await withCrypto(async () => {
    supabase.rpc.mockImplementation(async (name, args) => name === 'claimit_export_signing_evidence'
      ? { data: args.p_claim_ids.map((id) => ({ id })), error: null }
      : { data: null, error: null })
    const claims = makeClaims(3093)
    expect((await getExportSigningEvidence(claims)).claims).toHaveLength(3093)
    expect(await recordCxfExport(claims, new Uint8Array([1, 2, 3]))).toBeNull()
    expect(rpcCalls('claimit_export_signing_evidence')).toHaveLength(13)
    const recordCalls = rpcCalls('record_nhis_cxf_export_atomic')
    expect(recordCalls).toHaveLength(13)
    expect(Math.max(...recordCalls.map((call) => call[1].p_claim_ids.length))).toBe(250)
    expect(recordCalls.reduce((sum, call) => sum + call[1].p_claim_ids.length, 0)).toBe(3093)
    // every chunk carries the same artifact hash: the server uses it as the idempotency key
    expect(new Set(recordCalls.map((call) => call[1].p_artifact_sha256)).size).toBe(1)
  })
})

it('partial recording failure is visible and retry re-sends only the failed chunk, never regenerating the file', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await withCrypto(async () => {
    const claims = makeClaims(600) // chunks of 250, 250, 100
    let failSecondChunk = true
    supabase.rpc.mockImplementation(async (_name, args) => (failSecondChunk && args.p_claim_ids[0] === 'claim-250')
      ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', status: 500 } }
      : { data: null, error: null })
    const warning = await recordCxfExport(claims, new Uint8Array([9, 9]), 'why', { exportRef: 'run-7', retryDelayMs: 0 })
    expect(warning).toMatchObject({ warnings: ['EXPORT_AUDIT_NOT_RECORDED'] })
    expect(countUnrecordedClaims(warning.recording)).toBe(250)
    const sha = warning.recording.artifactSha256
    expect(log.mock.calls.at(-1)[1]).toMatchObject({ rpc: 'record_nhis_cxf_export_atomic', code: '57014', exportRef: 'run-7', chunk: 2, chunkCount: 3, facilityId: 'facility-1' })

    supabase.rpc.mockClear()
    failSecondChunk = false
    expect(await retryCxfRecording(warning.recording)).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledTimes(1) // only the failed chunk, same artifact hash and reason
    expect(supabase.rpc.mock.calls[0][1]).toMatchObject({ p_artifact_sha256: sha, p_reexport_reason: 'why' })
    expect(supabase.rpc.mock.calls[0][1].p_claim_ids[0]).toBe('claim-250')
    expect(countUnrecordedClaims(warning.recording)).toBe(0)
  })
  log.mockRestore()
})

it('retries a transient recording failure once, but never retries a deterministic one', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await withCrypto(async () => {
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } }).mockResolvedValueOnce({ data: null, error: null })
    expect(await recordCxfExport(makeClaims(2), new Uint8Array([1]), null, { retryDelayMs: 0 })).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledTimes(2)

    supabase.rpc.mockClear()
    supabase.rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'Claim changed during export; regenerate the file.' } })
    expect(await recordCxfExport(makeClaims(2), new Uint8Array([1]), null, { retryDelayMs: 0 })).toMatchObject({ warnings: ['EXPORT_AUDIT_NOT_RECORDED'] })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })
  log.mockRestore()
})
