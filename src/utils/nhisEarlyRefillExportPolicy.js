// NHIS-007: "early refill review" export blockers can be released per pharmacy.
//
// During export each claim's medicines go through the active-medication check.
// Every alert becomes an "Export blocked: ... early refill" blocker. An
// organization administrator may allow ONE alert type through: the
// `early_refill_review` match type (the text "has early refill review"). All
// other alert types (same ingredient, completion supply, partial supply, same
// code) and every other export blocker keep blocking, whatever the setting.
export const NHIS_EARLY_REFILL_RELEASABLE_MATCH_TYPE = 'early_refill_review'

const MAX_AUDIT_CLAIMS = 25

const normalizeMatchType = (alert) => String(alert?.match_type ?? alert?.matchType ?? '').trim().toLowerCase()

export const isNhisEarlyRefillReviewAlert = (alert) =>
  normalizeMatchType(alert) === NHIS_EARLY_REFILL_RELEASABLE_MATCH_TYPE

// Splits one claim's alerts into those that still block and those the policy releases.
// With the policy off (or anything other than `true`), nothing is released.
export const splitNhisEarlyRefillAlerts = (alerts = [], { allow = false } = {}) => {
  const list = Array.isArray(alerts) ? alerts : []
  if (allow !== true) return { blocking: list, released: [] }

  const blocking = []
  const released = []
  for (const alert of list) {
    if (isNhisEarlyRefillReviewAlert(alert)) released.push(alert)
    else blocking.push(alert)
  }
  return { blocking, released }
}

// Compact, claim-level summary for the audit trail. `entries` are
// { claimId, claimNumber, medicine } records collected while releasing alerts.
export const buildNhisEarlyRefillReleaseSummary = (entries = []) => {
  const byClaim = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = String(entry?.claimId ?? entry?.claimNumber ?? '').trim()
    if (!key) continue
    const existing = byClaim.get(key) || {
      claim_id: String(entry.claimId ?? '').trim() || null,
      claim_number: String(entry.claimNumber ?? '').trim() || null,
      medicines: [],
    }
    const medicine = String(entry.medicine ?? '').trim()
    if (medicine && !existing.medicines.includes(medicine)) existing.medicines.push(medicine)
    byClaim.set(key, existing)
  }

  const claims = Array.from(byClaim.values())
  return {
    claim_count: claims.length,
    claims: claims.slice(0, MAX_AUDIT_CLAIMS),
    truncated: claims.length > MAX_AUDIT_CLAIMS,
  }
}
