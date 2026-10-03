export const requireNhisCloudServing = () => {
  throw Object.assign(new Error(
    'NHIS serving requires an online medication coverage check. Save a pending claim, sync it, then serve it in the HealthFlow cloud workspace. Medicines must not be handed out before that check succeeds.'
  ), { status: 409, code: 'NHIS_ONLINE_SERVING_REQUIRED' })
}

// Imports of authoritative cloud history use importOfflineRecords, not this
// local write path. Local writes must never manufacture a completed supply.
export const assertNhisUnservedLocalDraft = (claim = {}) => {
  const servedStates = ['served', 'partially_served', 'fully_served', 'claim_ready', 'submitted', 'approved', 'accepted', 'paid']
  const medicines = claim.nhis_claim_medicines || claim.medicines || []
  if (servedStates.includes(claim.status) ||
      ['fully_served', 'partially_served'].includes(claim.serving_status ?? claim.servingStatus) ||
      claim.direct_served_at || claim.directServedAt ||
      medicines.some(m => Number(m.served_qty ?? m.servedQty ?? 0) > 0 ||
        ['fully_served', 'partially_served'].includes(m.serving_status ?? m.servingStatus))) {
    requireNhisCloudServing()
  }
}
