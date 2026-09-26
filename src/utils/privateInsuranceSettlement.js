// Private Insurance (POS): the pharmacy's normal selling bill is the basis. The insurer covers some or all of it
// (the cashier enters or confirms the agreed cover); the patient pays the rest. No NHIS tariff is involved and no
// NHIS claim is created. NHIA Claim is a separate model (see nhisSplitSettlement.js).

const money = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * patientTopUp = max(0, normalTotal - insuranceCover). An insurer cover above the bill is capped at the bill
 * (no credit to the patient); a negative cover counts as none.
 */
export const calculatePrivateInsuranceSettlement = ({ normalTotal = 0, insuranceCover = 0 } = {}) => {
  const total = Math.max(0, money(normalTotal))
  const cover = Math.min(Math.max(0, money(insuranceCover)), total)
  const patientTopUp = Math.max(0, money(total - cover))
  return {
    normalTotal: total,
    insuranceCover: cover,
    patientTopUp,
    patientDueAmount: patientTopUp,
  }
}
