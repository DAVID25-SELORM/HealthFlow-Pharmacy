export const ACTIVE_DRUG_DUPLICATE_ERROR =
  'This medicine already exists in inventory. Search for it and update the stock instead.'

// Ignore bookkeeping timestamps when deciding whether catalog sync has work.
// Keep strict value comparisons: normalization differences are real updates.
export const hasCatalogChanges = (existing: Record<string, unknown>, values: Record<string, unknown>) =>
  Object.entries(values).some(([key, value]) => key !== 'updated_at' && existing[key] !== value)

const normalizeStatus = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

export const isActiveDrugRecord = (drug: Record<string, unknown> | null | undefined) =>
  normalizeStatus(drug?.status) === 'active'

export const getExistingDrugSaveAction = (
  drug: Record<string, unknown> | null | undefined
): 'create' | 'reactivate' | 'update_existing' => {
  if (!drug) {
    return 'create'
  }

  return isActiveDrugRecord(drug) ? 'update_existing' : 'reactivate'
}
