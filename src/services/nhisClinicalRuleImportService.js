import { readSheet } from 'read-excel-file/browser'
import writeExcelFile from 'write-excel-file/browser'
import { normalizeText } from '../utils/validation'

const MAX_IMPORT_FILE_SIZE_BYTES = 2 * 1024 * 1024

const COLUMN_ALIASES = {
  diagnosis_label: ['diagnosis', 'diagnosis label', 'condition', 'clinical condition'],
  diagnosis_keywords: ['diagnosis keywords', 'diagnosis keyword', 'keywords', 'diagnosis terms'],
  allowed_drug_codes: ['allowed drug codes', 'drug codes', 'nhis codes', 'nhia codes', 'codes'],
  allowed_drug_keywords: ['allowed drug keywords', 'drug keywords', 'medicine keywords', 'treatment keywords', 'treatments'],
  severity: ['severity', 'action'],
  organization_type: ['organization type', 'facility type', 'type'],
  notes: ['notes', 'comment', 'comments'],
}

const resolveHeader = (header) => {
  const normalized = normalizeText(header).toLowerCase()
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return field
    }
  }
  return null
}

const splitList = (value) =>
  String(value || '')
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)

const normalizeSeverity = (value) =>
  normalizeText(value).toLowerCase() === 'warn' ? 'warn' : 'block'

const normalizeOrganizationType = (value) => {
  const normalized = normalizeText(value).toLowerCase()
  return ['hospital', 'pharmacy', 'all'].includes(normalized) ? normalized : 'hospital'
}

export const parseNhisClinicalRuleFile = async (file) =>
  new Promise((resolve, reject) => {
    if (file?.size > MAX_IMPORT_FILE_SIZE_BYTES) {
      reject(new Error('Import file is too large. Please upload a file smaller than 2 MB.'))
      return
    }

    readSheet(file)
      .then((rawRows) => {
        if (!rawRows.length) {
          resolve({ rows: [], errors: ['File appears to be empty.'], headerMap: {} })
          return
        }

        let headerRowIndex = 0
        let headerMap = {}
        for (let i = 0; i < Math.min(5, rawRows.length); i++) {
          const candidate = rawRows[i]
          const mapped = {}
          let matchCount = 0
          for (let j = 0; j < candidate.length; j++) {
            const field = resolveHeader(String(candidate[j] || ''))
            if (field) {
              mapped[field] = j
              matchCount += 1
            }
          }
          if (matchCount >= 2) {
            headerRowIndex = i
            headerMap = mapped
            break
          }
        }

        const errors = []
        if (headerMap.diagnosis_label === undefined || headerMap.diagnosis_keywords === undefined) {
          resolve({
            rows: [],
            errors: ['Could not find required columns. Include Diagnosis and Diagnosis Keywords.'],
            headerMap,
          })
          return
        }

        const rows = []
        for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
          const raw = rawRows[i]
          const get = (field) => {
            const index = headerMap[field]
            return index === undefined ? '' : String(raw[index] ?? '').trim()
          }

          const label = get('diagnosis_label')
          const diagnosisKeywords = splitList(get('diagnosis_keywords'))
          const drugCodes = splitList(get('allowed_drug_codes')).map((code) => code.toUpperCase())
          const drugKeywords = splitList(get('allowed_drug_keywords'))

          if (!label && !diagnosisKeywords.length && !drugCodes.length && !drugKeywords.length) continue
          if (!label) {
            errors.push(`Row ${i + 1}: Missing diagnosis label.`)
            continue
          }
          if (!diagnosisKeywords.length) {
            errors.push(`Row ${i + 1}: Missing diagnosis keywords for ${label}.`)
            continue
          }
          if (!drugCodes.length && !drugKeywords.length) {
            errors.push(`Row ${i + 1}: Add at least one allowed drug code or drug keyword for ${label}.`)
            continue
          }

          rows.push({
            diagnosis_label: label,
            diagnosis_keywords: diagnosisKeywords,
            allowed_drug_codes: drugCodes,
            allowed_drug_keywords: drugKeywords,
            severity: normalizeSeverity(get('severity')),
            organization_type: normalizeOrganizationType(get('organization_type')),
            notes: get('notes') || null,
          })
        }

        resolve({ rows, errors, headerMap })
      })
      .catch((error) => reject(new Error(`Failed to parse file: ${error.message}`)))
  })

export const generateNhisClinicalRuleTemplate = async () => {
  const headers = [
    'diagnosis_label',
    'diagnosis_keywords',
    'allowed_drug_codes',
    'allowed_drug_keywords',
    'severity',
    'organization_type',
    'notes',
  ]
  const sample = [
    ['Malaria', 'malaria; plasmodium', '', 'artemether; lumefantrine; artesunate; quinine', 'block', 'hospital', 'Add exact NHIA drug codes when available.'],
    ['Hypertension', 'hypertension; blood pressure', '', 'amlodipine; losartan; lisinopril; nifedipine', 'block', 'hospital', ''],
  ]

  return await writeExcelFile([headers, ...sample]).toBlob()
}
