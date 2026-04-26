export const ACTIVE_DRUG_DUPLICATE_ERROR =
  'This medicine already exists in inventory. Search for it and update the stock instead.'

const normalizeStatus = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

export const isActiveDrugRecord = (drug: Record<string, unknown> | null | undefined) =>
  normalizeStatus(drug?.status) === 'active'

export const getExistingDrugSaveAction = (
  drug: Record<string, unknown> | null | undefined
): 'create' | 'reactivate' | 'duplicate_active' => {
  if (!drug) {
    return 'create'
  }

  return isActiveDrugRecord(drug) ? 'duplicate_active' : 'reactivate'
}
