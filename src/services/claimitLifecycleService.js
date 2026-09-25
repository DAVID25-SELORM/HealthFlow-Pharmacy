import { supabase } from '../lib/supabase'

async function rpc(name, args) {
  const result = await supabase.rpc(name, args)
  if (!result || result.error) throw result?.error || new Error('Claim signing service is unavailable. Connect to the cloud and retry.')
  return result.data
}

export const signNhisClaim = (claimId, reason) => rpc('sign_nhis_claim', { p_claim_id: claimId, p_reason: reason })
export const repairClaimItTotal = (claimId, fingerprint) => rpc('repair_nhis_claimit_total', { p_claim_id: claimId, p_expected_fingerprint: fingerprint })

export const auditClaimItClaims = ({ after = null, apply = false, dateFrom = null, dateTo = null, status = null } = {}) =>
  rpc('audit_nhis_claimit', { p_after: after, p_limit: 100, p_apply: apply, p_date_from: dateFrom || null, p_date_to: dateTo || null, p_status: status || null })

const SIGNING_FIELDS = ['signed_on', 'signed_by_user_id', 'signed_by_name', 'signed_by_role', 'claimit_signature_id', 'claimit_fingerprint']

// Each RPC call must finish inside the database's 8 s statement timeout for the `authenticated` role.
// Measured on production: ~7 ms per claim, so 250 claims is ~2 s. (The old 500-claim calls that returned
// every claim snapshot, including its base64 prescription PDF, timed out with HTTP 500.)
const EVIDENCE_CHUNK_SIZE = 250
const LEGACY_EVIDENCE_CHUNK_SIZE = 500
const RECORD_CHUNK_SIZE = 250
const RECORD_ATTEMPTS = 2
const RECORD_RETRY_DELAY_MS = 1000

const isMissingRpc = (error) =>
  error?.code === 'PGRST202' || error?.code === '42883' ||
  /could not find the function|function .* does not exist/i.test(String(error?.message || ''))

// Deterministic failures are never worth an immediate retry: access denied, bad parameters, "claim changed".
const isDeterministicRpcFailure = (error) => ['42501', '22023', '40001'].includes(String(error?.code || ''))

/**
 * Structured, PHI-free diagnostics for a failed export RPC. Keeps the Postgres SQLSTATE, message, detail and
 * hint that Supabase exposes instead of reducing them to "500 Internal Server Error".
 */
export const logClaimItRpcFailure = (rpcName, error, context = {}) => {
  if (typeof console === 'undefined') return
  console.error('[CLAIM-it export RPC failed]', {
    rpc: rpcName,
    code: error?.code || null,
    message: error?.message || String(error || ''),
    details: error?.details || null,
    hint: error?.hint || null,
    status: error?.status || error?.context?.status || null,
    ...context,
  })
}

const facilityIdOf = (claims) => claims.find((claim) => claim?.organization_id)?.organization_id || null

// Signing is a HealthFlow audit feature, not a Claim-IT requirement (the accepted June export had null signers
// on every claim). This only MERGES stored signing evidence onto the caller's own claim rows; it never blocks,
// replaces clinical data with a server copy, or invents a signer. Any failure degrades to the unsigned legacy
// path and is reported as a warning.
export async function getExportSigningEvidence(candidates, { exportRef = null } = {}) {
  const unavailable = (code) => ({ claims: candidates, warnings: [{ claimNumber: '', warnings: [code] }] })
  const claimIds = candidates.map((claim) => claim.id)
  if (!claimIds.length || claimIds.length > 10000 || claimIds.some((id) => !id) || new Set(claimIds).size !== claimIds.length) {
    return unavailable('SIGNING_EVIDENCE_SKIPPED_INVALID_BATCH')
  }
  const evidence = new Map()
  let useLegacy = false
  let chunkSize = EVIDENCE_CHUNK_SIZE
  let rpcName = 'claimit_export_signing_evidence'
  const context = { exportRef, facilityId: facilityIdOf(candidates), claimCount: claimIds.length }
  try {
    for (let offset = 0; offset < claimIds.length; offset += chunkSize) {
      const args = { p_claim_ids: claimIds.slice(offset, offset + chunkSize), p_reexport_reason: null }
      let rows
      try {
        rows = await rpc(rpcName, args)
      } catch (error) {
        // The slim RPC ships with a migration. Until it is applied, fall back to the legacy call (which only
        // works for small batches) rather than losing evidence for exports that used to work.
        if (useLegacy || !isMissingRpc(error)) throw error
        useLegacy = true
        rpcName = 'claimit_export_claims'
        chunkSize = LEGACY_EVIDENCE_CHUNK_SIZE
        offset = -chunkSize // the loop increment restarts at 0 with the legacy chunk size
        continue
      }
      if (!Array.isArray(rows)) return unavailable('SIGNING_EVIDENCE_UNAVAILABLE')
      for (const row of rows) evidence.set(row.id, row)
    }
  } catch (error) {
    logClaimItRpcFailure(rpcName, error, { ...context, chunkSize })
    return unavailable('SIGNING_EVIDENCE_UNAVAILABLE')
  }
  return {
    warnings: [],
    claims: candidates.map((claim) => {
      const row = evidence.get(claim.id)
      if (!row) return claim
      return { ...claim, ...Object.fromEntries(SIGNING_FIELDS.filter((key) => row[key] != null).map((key) => [key, row[key]])) }
    }),
  }
}

const recordingWarning = (recording) => ({
  claimNumber: '',
  warnings: ['EXPORT_AUDIT_NOT_RECORDED'],
  // The generated file is fine; only these chunks still need recording. Carries no patient data.
  recording,
})

const recordChunk = async (recording, chunk, index) => {
  let lastError
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    try {
      await rpc('record_nhis_cxf_export_atomic', {
        p_claim_ids: chunk.claimIds,
        p_fingerprints: chunk.fingerprints,
        p_artifact_sha256: recording.artifactSha256,
        p_reexport_reason: recording.reason,
      })
      return true
    } catch (error) {
      lastError = error
      if (isDeterministicRpcFailure(error) || attempt === RECORD_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, recording.retryDelayMs))
    }
  }
  logClaimItRpcFailure('record_nhis_cxf_export_atomic', lastError, {
    exportRef: recording.exportRef,
    facilityId: recording.facilityId,
    claimCount: recording.claimCount,
    chunk: index + 1,
    chunkCount: recording.chunks.length,
    chunkClaimCount: chunk.claimIds.length,
  })
  return false
}

// Records the not-yet-recorded chunks. Idempotent on the server (same artifact + claim never records twice), so
// re-running after a timeout, a 500, or a success whose reply was lost cannot create duplicate events.
const runRecording = async (recording) => {
  for (const index of [...recording.pendingChunkIndexes]) {
    if (await recordChunk(recording, recording.chunks[index], index)) {
      recording.pendingChunkIndexes = recording.pendingChunkIndexes.filter((pending) => pending !== index)
    }
  }
  return recording.pendingChunkIndexes.length ? recordingWarning(recording) : null
}

/**
 * Best-effort audit trail of the released artifact. The file has already been generated: a failure here is
 * returned as a warning carrying a `recording` handle, never thrown, and `retryCxfRecording(recording)` repairs
 * it later without regenerating the file. Returns null only when every claim was recorded.
 */
export async function recordCxfExport(claims, bytes, reason = null, { exportRef = null, retryDelayMs = RECORD_RETRY_DELAY_MS } = {}) {
  const facilityId = facilityIdOf(claims)
  let sha256
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch (error) {
    logClaimItRpcFailure('artifact_sha256', error, { exportRef, facilityId, claimCount: claims.length })
    return { claimNumber: '', warnings: ['EXPORT_AUDIT_NOT_RECORDED'] }
  }
  const chunks = []
  for (let offset = 0; offset < claims.length; offset += RECORD_CHUNK_SIZE) {
    const slice = claims.slice(offset, offset + RECORD_CHUNK_SIZE)
    chunks.push({
      claimIds: slice.map((claim) => claim.id),
      fingerprints: Object.fromEntries(slice.map((claim) => [claim.id, claim.claimit_fingerprint ?? null])),
    })
  }
  const recording = {
    artifactSha256: sha256,
    reason,
    exportRef,
    facilityId,
    claimCount: claims.length,
    retryDelayMs,
    chunks,
    pendingChunkIndexes: chunks.map((_, index) => index),
  }
  return await runRecording(recording)
}

export const retryCxfRecording = (recording) => runRecording(recording)

export const countUnrecordedClaims = (recording) =>
  (recording?.pendingChunkIndexes || []).reduce((sum, index) => sum + recording.chunks[index].claimIds.length, 0)
