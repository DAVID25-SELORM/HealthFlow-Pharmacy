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

// Signing is a HealthFlow audit feature, not a Claim-IT requirement (the accepted
// June export had null signers on every claim). This only MERGES stored signing
// evidence onto the caller's own claim rows; it never blocks, replaces clinical data
// with a server copy, or invents a signer. Any failure degrades to the unsigned
// legacy path and is reported as a warning.
export async function getExportSigningEvidence(candidates) {
  const unavailable = (code) => ({ claims: candidates, warnings: [{ claimNumber: '', warnings: [code] }] })
  const claimIds = candidates.map((claim) => claim.id)
  if (!claimIds.length || claimIds.length > 10000 || claimIds.some((id) => !id) || new Set(claimIds).size !== claimIds.length) {
    return unavailable('SIGNING_EVIDENCE_SKIPPED_INVALID_BATCH')
  }
  const evidence = new Map()
  try {
    for (let offset = 0; offset < claimIds.length; offset += 500) {
      const rows = await rpc('claimit_export_claims', { p_claim_ids: claimIds.slice(offset, offset + 500), p_reexport_reason: null })
      if (!Array.isArray(rows)) return unavailable('SIGNING_EVIDENCE_UNAVAILABLE')
      for (const row of rows) evidence.set(row.id, row)
    }
  } catch {
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

// Best-effort audit trail of the released artifact. A failure (for example the
// claim changed while the file was generated) is returned as a warning; the
// generated file is still delivered.
export async function recordCxfExport(claims, bytes, reason = null) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
    await rpc('record_nhis_cxf_export_atomic', {
      p_claim_ids: claims.map((claim) => claim.id),
      p_fingerprints: Object.fromEntries(claims.map((claim) => [claim.id, claim.claimit_fingerprint ?? null])),
      p_artifact_sha256: sha256,
      p_reexport_reason: reason,
    })
    return null
  } catch {
    return { claimNumber: '', warnings: ['EXPORT_AUDIT_NOT_RECORDED'] }
  }
}
