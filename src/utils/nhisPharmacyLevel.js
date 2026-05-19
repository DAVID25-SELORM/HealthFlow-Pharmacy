// ✅ NHIS PHARMACY LEVEL PATCH START
export const PHARMACY_LEVELS = [
  { value: 'P1', label: 'P1 - Full pharmacy / higher pharmacy service level' },
  { value: 'P2', label: 'P2 - Restricted or lower pharmacy service level' },
  { value: 'LCS', label: 'LCS - Licensed Chemical Seller' },
  { value: 'HP', label: 'HP - Hospital Pharmacy' },
]

export const MEDICINE_ACCESS_LEVELS = [
  { value: 'OTC', label: 'OTC' },
  { value: 'Prescription', label: 'Prescription' },
  { value: 'Specialist', label: 'Specialist' },
  { value: 'Controlled', label: 'Controlled' },
]

const ACCESS_BY_PHARMACY_LEVEL = {
  LCS: ['OTC'],
  P2: ['OTC', 'Prescription'],
  P1: ['OTC', 'Prescription'],
  HP: ['OTC', 'Prescription', 'Specialist', 'Controlled'],
}

const PHARMACY_LEVEL_RANK = {
  LCS: 1,
  P2: 2,
  P1: 3,
  HP: 4,
}

export const normalizePharmacyLevel = (value, fallback = '') => {
  const normalized = String(value || '').trim().toUpperCase()
  return PHARMACY_LEVELS.some((level) => level.value === normalized) ? normalized : fallback
}

export const normalizeMedicineAccessLevel = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return MEDICINE_ACCESS_LEVELS.find((level) => level.value.toLowerCase() === normalized)?.value || ''
}

export const getEffectivePharmacyLevel = (...sources) => {
  for (const source of sources) {
    const level = normalizePharmacyLevel(
      source?.pharmacy_level ?? source?.pharmacyLevel ?? source?.providerClassLevel ?? source
    )
    if (level) return level
  }
  return ''
}

export const assessMedicinePharmacyLevel = (medicine = {}, pharmacyLevel = '') => {
  const facilityLevel = normalizePharmacyLevel(pharmacyLevel)
  const accessLevel = normalizeMedicineAccessLevel(
    medicine.medicine_access_level ?? medicine.medicineAccessLevel
  )
  const requiredLevel = normalizePharmacyLevel(
    medicine.required_pharmacy_level ?? medicine.requiredPharmacyLevel
  )

  if (!accessLevel && !requiredLevel) {
    return {
      allowed: true,
      severity: 'info',
      message: 'Level not configured',
      pharmacyLevel: facilityLevel,
      medicineAccessLevel: '',
      requiredPharmacyLevel: '',
    }
  }

  if (!facilityLevel) {
    return {
      allowed: true,
      severity: 'warning',
      message: 'Level not configured',
      pharmacyLevel: '',
      medicineAccessLevel: accessLevel,
      requiredPharmacyLevel: requiredLevel,
    }
  }

  const allowedByRequiredLevel =
    !requiredLevel || (PHARMACY_LEVEL_RANK[facilityLevel] || 0) >= (PHARMACY_LEVEL_RANK[requiredLevel] || 0)
  const allowedAccessLevels = ACCESS_BY_PHARMACY_LEVEL[facilityLevel] || []
  const allowedByAccessLevel = !accessLevel || allowedAccessLevels.includes(accessLevel)
  const allowed = allowedByRequiredLevel && allowedByAccessLevel

  return {
    allowed,
    severity: allowed ? 'ok' : 'block',
    message: allowed
      ? ''
      : 'This medicine is not allowed for your pharmacy/facility level and may cause NHIS claim rejection.',
    pharmacyLevel: facilityLevel,
    medicineAccessLevel: accessLevel,
    requiredPharmacyLevel: requiredLevel,
  }
}
// ✅ NHIS PHARMACY LEVEL PATCH END
