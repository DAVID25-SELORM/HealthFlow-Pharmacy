const INTAKE_EDITABLE_STATUSES = new Set([
  'pending_serving',
  'serving_in_progress',
])

const normalizeStatus = (status = '') => String(status || '').trim().toLowerCase()

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
  return normalizedStatus === 'returned_for_review' && Number(blockerCount) > 0
}
