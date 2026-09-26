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

const toInput = (value) => (Math.round((Number(value) || 0) * 100) / 100).toFixed(2)

/**
 * Keeps the two linked Private Insurance boxes consistent WITHOUT rewriting what the cashier is typing.
 * The field being edited keeps its raw text (so "40.0", "4." or an empty box can be typed); the other field is
 * derived, and a value above the bill is capped at the bill. `edited` is 'cover', 'topup' or '' (nothing typed yet).
 */
export const reconcilePrivateInsuranceInputs = ({ total, insuranceCover, patientTopUp, edited }) => {
  const bill = Math.max(0, Number(total) || 0)
  const clamp = (value) => Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), bill)
  if (edited === 'cover') {
    const typed = Number.parseFloat(insuranceCover)
    return {
      insuranceCover: Number.isFinite(typed) && typed > bill ? toInput(bill) : insuranceCover,
      patientTopUp: toInput(bill - clamp(typed)),
    }
  }
  if (edited === 'topup') {
    const typed = Number.parseFloat(patientTopUp)
    return {
      insuranceCover: toInput(bill - clamp(typed)),
      patientTopUp: Number.isFinite(typed) && typed > bill ? toInput(bill) : patientTopUp,
    }
  }
  // Nothing typed: default to the insurer covering the whole bill, clamped if the bill changed.
  const cover = insuranceCover === '' ? bill : clamp(Number.parseFloat(insuranceCover))
  return { insuranceCover: toInput(cover), patientTopUp: toInput(bill - cover) }
}
