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

export async function getSignedExportClaims(candidates, reason = null) {
  const claimIds = candidates.map((claim) => claim.id)
  if (!claimIds.length || claimIds.length > 10000) throw new Error('Select between 1 and 10000 claims per artifact.')
  if (claimIds.some((id) => !id) || new Set(claimIds).size !== claimIds.length) throw new Error('Duplicate or missing claim IDs.')
  const result = []
  for (let offset = 0; offset < claimIds.length; offset += 500) {
    const rows = await rpc('claimit_export_claims', { p_claim_ids: claimIds.slice(offset, offset + 500), p_reexport_reason: reason })
    if (!Array.isArray(rows) || rows.length !== claimIds.slice(offset, offset + 500).length) throw new Error('Incomplete server export validation')
    result.push(...rows)
  }
  return result
}

export async function recordCxfExport(claims, bytes, reason = null) {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  await rpc('record_nhis_cxf_export_atomic', {
    p_claim_ids: claims.map((claim) => claim.id),
    p_fingerprints: Object.fromEntries(claims.map((claim) => [claim.id, claim.claimit_fingerprint])),
    p_artifact_sha256: sha256,
    p_reexport_reason: reason,
  })
}
