// Categories and filter chips for the NHIS export readiness (claims scrub) list.
// Pure functions so they can be unit-tested; used by src/pages/Nhis.jsx.

export const READINESS_FILTERS = [
  { id: 'all', label: 'All issues' },
  { id: 'not_included', label: 'Not included in CXF' },
  { id: 'status', label: 'Not yet served/submitted' },
  { id: 'attachment', label: 'Attachment problems' },
  { id: 'identifier', label: 'Member/HIN' },
  { id: 'verification', label: 'Unverified prescription' },
  { id: 'prescriber', label: 'Prescriber' },
  { id: 'diagnosis', label: 'Diagnosis' },
  { id: 'clinical', label: 'Clinical rules' },
  { id: 'tariff', label: 'Tariff/G-DRG' },
  { id: 'medicine', label: 'Medicine' },
  { id: 'other', label: 'Other' },
]

// The Diagnosis chip only applies to hospital facilities.
export const getReadinessFilters = (isHospital = false) =>
  READINESS_FILTERS.filter((filter) => isHospital || filter.id !== 'diagnosis')

export const isReadinessIssueNotIncluded = (issue = {}) => (
  issue.exportInclusion === 'not_included' ||
  issue.export_inclusion === 'not_included' ||
  issue.exportInclusionReason === 'status_not_exportable' ||
  issue.export_inclusion_reason === 'status_not_exportable'
)

// Diagnosis is only a hospital concept. Pharmacy claims never carry a diagnosis
// requirement, so they are never tagged "diagnosis" (and never show that chip).
// "treatment day(s)" in dispensing/early-refill calculations is not a diagnosis.
export const getReadinessIssueCategories = (issue = {}, { isHospital = false } = {}) => {
  const text = (Array.isArray(issue.issues) ? issue.issues : [])
    .join(' ')
    .toLowerCase()
  const categories = new Set()

  if (isReadinessIssueNotIncluded(issue) || /\bnot included in (this )?cxf\b|\bnot included in the export\b/.test(text)) {
    categories.add('not_included')
  }
  if (/\bnot yet ready for export\b/.test(text)) {
    categories.add('status')
  }
  if (/\battach|attachment|prescription file|scanned|pdf|jpeg|png|document type\b/.test(text)) {
    categories.add('attachment')
  }
  if (/\bhin|ghana card|member\/card|member identifier|member no|membership number|card serial\b/.test(text)) {
    categories.add('identifier')
  }
  if (/\bverify|verified|unverified\b/.test(text)) {
    categories.add('verification')
  }
  if (/\bprescriber|physician|provider|referral|ccc|authorization|authorisation\b/.test(text)) {
    categories.add('prescriber')
  }
  if (isHospital && /\bdiagnosis|icd|treatment\b(?!\s+days?\b)/.test(text)) {
    categories.add('diagnosis')
  }
  if (/\bclinical|risk|critical|age-restricted|gender|pregnancy|obstetric|prostate|infection|antibiotic|antimicrobial|chronic|specialist|supporting diagnosis|supporting malaria|diagnosis-lab|lab review|typhoid|widal|bp reading|glucose|hba1c\b/.test(text)) {
    categories.add('clinical')
  }
  if (/\bg-drg|gdrg|tariff|service \d+|procedure|investigation|laboratory|lab|provider class|facility group|catering\b/.test(text)) {
    categories.add('tariff')
  }
  if (/\bmedicine|drug|quantity|dispensed|served|dosage|level\b/.test(text)) {
    categories.add('medicine')
  }
  if (!categories.size) categories.add('other')
  return Array.from(categories)
}
