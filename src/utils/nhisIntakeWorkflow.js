const INTAKE_EDITABLE_STATUSES = new Set([
  'draft',
  'pending_serving',
  'serving_in_progress',
])

const SCRUB_CORRECTION_STATUSES = new Set([
  'served',
  'claim_ready',
])

const normalizeStatus = (status = '') => String(status || '').trim().toLowerCase()

export const getNhisIntakeSaveStatus = ({
  intent = 'dispatch',
  currentStatus = '',
  isNew = false,
} = {}) => {
  if (intent === 'save_details') return 'draft'
  const normalizedStatus = normalizeStatus(currentStatus)
  if (isNew || normalizedStatus === 'draft') return 'pending_serving'
  return normalizedStatus
}

export const hasNhisPrescriptionAttachment = (claim = {}, pendingFile = null) =>
  Boolean(
    pendingFile ||
    claim.prescriptionFilePath ||
    claim.prescription_file_path ||
    claim.prescriptionFileUrl ||
    claim.prescription_file_url ||
    claim.claimitAttachmentBase64 ||
    claim.claimit_attachment_base64
  )

export const hasVerifiedNhisPrescription = (claim = {}, pendingFile = null) =>
  hasNhisPrescriptionAttachment(claim, pendingFile) &&
  String(claim.prescriptionDocumentType || claim.prescription_document_type || '').trim().toLowerCase() ===
    'prescription' &&
  (claim.prescriptionVerified ?? claim.prescription_verified) === true &&
  Boolean(claim.prescriptionVerifiedBy || claim.prescription_verified_by) &&
  Boolean(claim.prescriptionVerifiedAt || claim.prescription_verified_at)

export const getNhisPrescriptionAttachmentReview = (claim = {}, pendingFile = null) => {
  const attached = hasNhisPrescriptionAttachment(claim, pendingFile)
  const verified = hasVerifiedNhisPrescription(claim, pendingFile)

  return {
    attached,
    verified,
    label: attached ? (verified ? 'Attached and verified' : 'Attached') : 'Not attached',
    readyClass: attached ? 'review-value-ready' : 'review-value-warning',
  }
}

export const getNhisIncompleteIntakeItems = ({
  claim = {},
  medicines = [],
  pendingFile = null,
} = {}) => {
  const missing = []
  if (!Array.isArray(medicines) || medicines.length === 0) missing.push('medicines')
  if (!hasNhisPrescriptionAttachment(claim, pendingFile)) missing.push('prescription attachment')
  return missing
}

export const canSaveNhisIncompleteIntake = ({
  isMedicineCounterAssistant = false,
  isEditing = false,
  status = '',
  blockerCount = 0,
} = {}) => {
  if (isMedicineCounterAssistant) return false
  if (!isEditing) return true
  const normalizedStatus = normalizeStatus(status)
  if (INTAKE_EDITABLE_STATUSES.has(normalizedStatus)) return true
  if (SCRUB_CORRECTION_STATUSES.has(normalizedStatus) && Number(blockerCount) > 0) return true
  return normalizedStatus === 'returned_for_review' && Number(blockerCount) > 0
}
