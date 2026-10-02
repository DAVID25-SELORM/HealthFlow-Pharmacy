// Shared member-aware CCC classification for hosted and branch-server claim writes.
// CCC is an external attendance reference, never a patient identity. A normalized
// member number (or HIN) takes precedence; patient ID is a fallback only when both
// records lack membership identity. Names and medicine sets never establish identity.
const digitsOnly = (value) => String(value || '').replace(/\D/g, '')

export const NHIS_CCC_DUPLICATE_SEVERITY = Object.freeze({
  BLOCK: 'block', // category A: same member + same CCC + same service date + same total — an exact repeat; app layer only
  STRONG_WARNING: 'strong_warning', // category A (different total) and B: same member + same CCC, same day or within the warning window
  WARNING: 'warning', // category D: same member + same service date + a different CCC
  INFO: 'info', // category C: same CCC, a different member — never blocks
  REVIEW: 'review', // category E: same member + same CCC, but a clearly different service date
})

export const NHIS_CCC_DUPLICATE_REASON = Object.freeze({
  STRONG_DUPLICATE: 'strong_duplicate',
  STRONG_DUPLICATE_SAME_DAY: 'strong_duplicate_same_day',
  STRONG_DUPLICATE_WINDOW: 'strong_duplicate_window',
  SAME_MEMBER_DIFFERENT_CCC: 'same_member_different_ccc',
  SAME_CCC_DIFFERENT_MEMBER: 'same_ccc_different_member',
  SAME_MEMBER_SAME_CCC_DIFFERENT_DATE: 'same_member_same_ccc_different_date',
})

// "Very close" service dates for the same member + same CCC (category B) vs. a date far enough apart that it only
// warrants a soft review (category E). Not a hard NHIA rule — a reasonable, named default the caller can override.
export const NHIS_CCC_WARNING_WINDOW_DAYS = 3
export const NHIS_CCC_INFO_WINDOW_DAYS = 7

const VOIDED_STATUSES = new Set(['rejected', 'failed', 'cancelled', 'canceled', 'voided'])
export const isVoidedNhisClaim = (status) => VOIDED_STATUSES.has(String(status || '').trim().toLowerCase())

const normalizeCcc = (value) => String(value ?? '').replace(/\D/g, '')
export const nhisDuplicateMemberKey = (row) => digitsOnly(row?.memberNo || row?.member_no) || digitsOnly(row?.hin)
const memberKeyOf = nhisDuplicateMemberKey
const patientIdOf = (row) => String(row?.patientId || row?.patient_id || '')
const facilityOf = (row) => String(row?.organizationId || row?.organization_id || '')
const cccOf = (row) => normalizeCcc(row?.ccc ?? row?.cccNo ?? row?.ccCode ?? row?.ccc_no)
const serviceDateOf = (row) => String(row?.serviceDate ?? row?.service_date_from ?? '').slice(0, 10)
const idOf = (row) => String(row?.id ?? '')
const statusOf = (row) => String(row?.status ?? '')
const totalOf = (row) => {
  const value = Number(row?.totalAmount ?? row?.total_amount ?? 0)
  return Number.isFinite(value) ? value : 0
}
const medicinesOf = (row) => {
  const list = row?.medicines ?? row?.nhis_claim_medicines ?? row?.medicineCodes ?? row?.medicine_codes ?? []
  return Array.from(new Set((Array.isArray(list) ? list : []).map((entry) =>
    String(entry?.code ?? entry?.drugCode ?? entry?.drug_code ?? (typeof entry === 'string' ? entry : '')).trim().toUpperCase()
  ).filter(Boolean)))
}

// A secondary confidence signal only — never used on its own to decide a category. Two claims genuinely about the
// same encounter tend to carry the same (or overlapping) medicines; this does not replace the member+CCC+date model.
export const NHIS_CCC_MEDICINE_OVERLAP_PROMOTION_THRESHOLD = 0.5

const medicineOverlapRatio = (a, b) => {
  if (!a.length || !b.length) return null
  const setB = new Set(b)
  const intersection = a.filter((code) => setB.has(code)).length
  const union = new Set([...a, ...b]).size
  return union ? intersection / union : null
}

const daysBetween = (a, b) => {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay)
}

export const summarizeNhisCccDuplicateClaim = (row = {}) => ({
  id: idOf(row),
  claimNumber: String(row.claimNumber ?? row.claim_number ?? '') || null,
  memberNo: String(row.memberNo ?? row.member_no ?? '') || null,
  status: statusOf(row),
  serviceDate: serviceDateOf(row) || null,
  totalAmount: Number(row.totalAmount ?? row.total_amount ?? 0),
  ccc: cccOf(row),
  medicines: medicinesOf(row),
})

/**
 * Classifies a candidate claim's CCC/member/service-date combination against other claims already on file at the
 * same facility. `candidate` and each entry of `others` accept either camelCase or the database's snake_case field
 * names. Returns an array of signals (possibly empty — nothing worth mentioning), most severe first; a row that
 * does not share the candidate's CCC and is not a same-member/same-date match with a different CCC produces no
 * signal at all. Rows in `others` whose status is rejected/failed are never treated as a live duplicate (category A
 * or B), matching the database guard, but a rejected/failed row sharing the CCC with a different member can still
 * surface the informational category C notice (NHIA's own record of that CCC, not affected by HealthFlow's status).
 */
export const classifyNhisCccDuplicateSignals = (candidate, others = [], { warningWindowDays = NHIS_CCC_WARNING_WINDOW_DAYS } = {}) => {
  const ccc = cccOf(candidate)
  const memberKey = memberKeyOf(candidate)
  const serviceDate = serviceDateOf(candidate)
  const candidateId = idOf(candidate)
  const candidateMedicines = medicinesOf(candidate)
  if (isVoidedNhisClaim(statusOf(candidate))) return []

  const severityOrder = [
    NHIS_CCC_DUPLICATE_SEVERITY.BLOCK,
    NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING,
    NHIS_CCC_DUPLICATE_SEVERITY.WARNING,
    NHIS_CCC_DUPLICATE_SEVERITY.REVIEW,
    NHIS_CCC_DUPLICATE_SEVERITY.INFO,
  ]
  const signals = []

  for (const row of others) {
    if (facilityOf(candidate) && facilityOf(row) && facilityOf(candidate) !== facilityOf(row)) continue
    const rowId = idOf(row)
    if (rowId && candidateId && rowId === candidateId) continue
    const rowCcc = cccOf(row)
    const rowMemberKey = memberKeyOf(row)
    const rowDate = serviceDateOf(row)
    const sameMember = memberKey && rowMemberKey
      ? memberKey === rowMemberKey
      : !memberKey && !rowMemberKey && Boolean(patientIdOf(candidate)) && patientIdOf(candidate) === patientIdOf(row)
    const sameCcc = Boolean(rowCcc) && rowCcc === ccc
    const voided = isVoidedNhisClaim(statusOf(row))

    if (sameCcc && sameMember) {
      if (voided) continue // a rejected/failed claim is not a live duplicate of itself
      if (!rowDate || !serviceDate) {
        signals.push({
          severity: NHIS_CCC_DUPLICATE_SEVERITY.REVIEW,
          reasonCode: NHIS_CCC_DUPLICATE_REASON.SAME_MEMBER_SAME_CCC_DIFFERENT_DATE,
          message: 'This patient has another claim using this CCC/CC code. Review the existing claim before continuing.',
          claim: summarizeNhisCccDuplicateClaim(row),
        })
        continue
      }
      const diff = Math.abs(daysBetween(serviceDate, rowDate))
      if (diff === 0) {
        // One NHIA visit code can legitimately cover several prescriptions on the same day, each its own claim
        // with its own total (production holds many such groups). Only an exact repeat — same member, CCC, day
        // and total — is treated as a double entry and blocked; anything else needs explicit review.
        const total = totalOf(candidate)
        const rowTotal = totalOf(row)
        const sameTotal = total > 0 && rowTotal > 0 && Math.abs(total - rowTotal) < 0.005
        signals.push(sameTotal
          ? {
            severity: NHIS_CCC_DUPLICATE_SEVERITY.BLOCK,
            reasonCode: NHIS_CCC_DUPLICATE_REASON.STRONG_DUPLICATE,
            message: 'Possible duplicate claim: this patient already has a claim using this CCC/CC code for the same service date and total. Review the existing claim before continuing.',
            claim: summarizeNhisCccDuplicateClaim(row),
          }
          : {
            severity: NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING,
            reasonCode: NHIS_CCC_DUPLICATE_REASON.STRONG_DUPLICATE_SAME_DAY,
            message: 'This patient already has another claim using this CCC/CC code for the same service date (for example a second prescription from the same visit). Review the existing claim before continuing.',
            claim: summarizeNhisCccDuplicateClaim(row),
            medicineOverlapRatio: medicineOverlapRatio(candidateMedicines, medicinesOf(row)),
          })
      } else if (diff <= warningWindowDays) {
        signals.push({
          severity: NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING,
          reasonCode: NHIS_CCC_DUPLICATE_REASON.STRONG_DUPLICATE_WINDOW,
          message: `Possible duplicate claim: this patient has another claim using this CCC/CC code ${diff} day${diff === 1 ? '' : 's'} apart. Review the existing claim before continuing.`,
          claim: summarizeNhisCccDuplicateClaim(row),
          medicineOverlapRatio: medicineOverlapRatio(candidateMedicines, medicinesOf(row)),
        })
      } else {
        signals.push({
          severity: NHIS_CCC_DUPLICATE_SEVERITY.REVIEW,
          reasonCode: NHIS_CCC_DUPLICATE_REASON.SAME_MEMBER_SAME_CCC_DIFFERENT_DATE,
          message: 'This patient has another claim using this CCC/CC code for a different service date. Review the existing claim before continuing.',
          claim: summarizeNhisCccDuplicateClaim(row),
          medicineOverlapRatio: medicineOverlapRatio(candidateMedicines, medicinesOf(row)),
        })
      }
      continue
    }

    if (sameCcc && !sameMember) {
      // A short numeric code recurs across the facility over time; only a recent reuse is worth a notice.
      if (serviceDate && rowDate && Math.abs(daysBetween(serviceDate, rowDate)) > NHIS_CCC_INFO_WINDOW_DAYS) continue
      signals.push({
        severity: NHIS_CCC_DUPLICATE_SEVERITY.INFO,
        reasonCode: NHIS_CCC_DUPLICATE_REASON.SAME_CCC_DIFFERENT_MEMBER,
        message: 'CCC/CC also recorded on another member’s claim. This does not automatically prevent this claim. Verify the member details before continuing.',
        claim: summarizeNhisCccDuplicateClaim(row),
      })
      continue
    }

    if (sameMember && serviceDate && rowDate === serviceDate && !voided) {
      const overlap = medicineOverlapRatio(candidateMedicines, medicinesOf(row))
      // Medicine overlap is only ever a confidence booster here, never the deciding factor on its own: it can
      // promote an already-raised same-member/same-date signal to a stronger warning, but it never creates a
      // signal by itself and it never reaches BLOCK (that stays reserved for the same-CCC case above).
      const strongOverlap = overlap !== null && overlap >= NHIS_CCC_MEDICINE_OVERLAP_PROMOTION_THRESHOLD
      signals.push({
        severity: strongOverlap ? NHIS_CCC_DUPLICATE_SEVERITY.STRONG_WARNING : NHIS_CCC_DUPLICATE_SEVERITY.WARNING,
        reasonCode: NHIS_CCC_DUPLICATE_REASON.SAME_MEMBER_DIFFERENT_CCC,
        message: strongOverlap
          ? 'This patient already has another claim for the same service date with overlapping medicines. Review the existing claim before continuing.'
          : 'This patient already has another claim for the same service date. Review the existing claim before continuing.',
        claim: summarizeNhisCccDuplicateClaim(row),
        medicineOverlapRatio: overlap,
      })
    }
  }

  return signals.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity))
}

export const getStrongestNhisCccDuplicateSignal = (signals = []) => signals[0] || null

export const isBlockingNhisCccDuplicateSignal = (signal) => signal?.severity === NHIS_CCC_DUPLICATE_SEVERITY.BLOCK
