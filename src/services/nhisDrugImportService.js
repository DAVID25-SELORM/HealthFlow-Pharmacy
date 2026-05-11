import { readSheet } from 'read-excel-file/browser'
import writeExcelFile from 'write-excel-file/browser'
import { normalizeText } from '../utils/validation'

// Expected column names (case-insensitive aliases)
const COLUMN_ALIASES = {
  code:         ['code', 'drug code', 'item code', 'nhis code', 'drug_code', 'item_code'],
  description:  [
    'description',
    'name',
    'drug name',
    'item name',
    'medicine',
    'drug_name',
    'generic name, dosage form, strength',
  ],
  generic_name: ['generic name', 'generic', 'generic_name', 'inn'],
  strength:     ['strength', 'dosage strength', 'concentration'],
  dosage_form:  ['dosage form', 'form', 'dosage_form', 'formulation', 'type'],
  category:     ['category', 'class', 'group', 'therapeutic class', 'level of prescribing'],
  unit:         ['unit', 'pack unit', 'dispensing unit', 'uom'],
  unit_price:   ['unit price', 'price', 'price (ghc)', 'tariff', 'cost', 'amount', 'rate', 'unit_price'],
}
const MAX_IMPORT_FILE_SIZE_BYTES = 2 * 1024 * 1024

const resolveHeader = (header) => {
  const normalized = normalizeText(header).toLowerCase()
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      return field
    }
  }
  return null
}

const toPrice = (value) => {
  const parsed = Number.parseFloat(String(value || '').replace(/,/g, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : 0
}

const mapUnit = (rawUnit) => {
  const u = String(rawUnit || '').toLowerCase().trim()
  if (!u) return 'unit'
  if (u.includes('tab'))   return 'tablet'
  if (u.includes('cap'))   return 'capsule'
  if (u.includes('syr') || u.includes('syrup')) return 'syrup'
  if (u.includes('inj') || u.includes('vial'))  return 'vial'
  if (u.includes('cream') || u.includes('oint')) return 'cream'
  if (u.includes('susp'))  return 'suspension'
  if (u.includes('drop'))  return 'drops'
  if (u.includes('supp'))  return 'suppository'
  if (u.includes('sach'))  return 'sachet'
  if (u.includes('bottle')) return 'bottle'
  return u || 'unit'
}

/**
 * Parses an uploaded CSV or Excel file into validated NHIS drug rows.
 * Returns { rows: ValidRow[], errors: string[], headerMap: object }
 */
export const parseNhisDrugFile = async (file) => {
  return new Promise((resolve, reject) => {
    if (file?.size > MAX_IMPORT_FILE_SIZE_BYTES) {
      reject(new Error('Import file is too large. Please upload a file smaller than 2 MB.'))
      return
    }

    readSheet(file)
      .then((rawRows) => {
        if (!rawRows.length) {
          return resolve({ rows: [], errors: ['File appears to be empty.'], headerMap: {} })
        }

        // Detect header row (first row with recognisable column names)
        let headerRowIndex = 0
        let headerMap = {}

        for (let i = 0; i < Math.min(5, rawRows.length); i++) {
          const candidate = rawRows[i]
          const mapped = {}
          let matchCount = 0
          for (let j = 0; j < candidate.length; j++) {
            const field = resolveHeader(String(candidate[j]))
            if (field) {
              mapped[field] = j
              matchCount++
            }
          }
          if (matchCount >= 2) {
            headerRowIndex = i
            headerMap = mapped
            break
          }
        }

        const errors = []
        if (!headerMap.description && !headerMap.code) {
          errors.push(
            'Could not find required columns. Ensure your file has columns for Code and Description.'
          )
          return resolve({ rows: [], errors, headerMap })
        }

        const rows = []
        for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
          const raw = rawRows[i]

          const get = (field) => {
            const idx = headerMap[field]
            return idx !== undefined ? String(raw[idx] ?? '').trim() : ''
          }

          const code = get('code').toUpperCase()
          const description = get('description')
          const unitPrice = toPrice(get('unit_price'))

          // Skip blank rows
          if (!code && !description) continue

          if (!description) {
            errors.push(`Row ${i + 1}: Missing description (code: ${code || 'n/a'})`)
            continue
          }

          rows.push({
            code:         code || `AUTO-${String(i).padStart(4, '0')}`,
            description,
            generic_name: get('generic_name') || null,
            strength:     get('strength')     || null,
            dosage_form:  get('dosage_form')  || null,
            category:     get('category')     || null,
            unit:         mapUnit(get('unit')),
            unit_price:   unitPrice,
          })
        }

        resolve({ rows, errors, headerMap })
      })
      .catch((err) => reject(new Error(`Failed to parse file: ${err.message}`)))
  })
}

/**
 * Returns a sample template as a Blob for download.
 */
export const generateNhisDrugTemplate = async () => {
  const headers = ['code', 'description', 'generic_name', 'strength', 'dosage_form', 'category', 'unit', 'unit_price']
  const sample = [
    ['TAMSULCA1', 'Tamsulosin Capsule, 400mcg', 'Tamsulosin', '400mcg', 'Capsule', 'Urology', 'capsule', '2.18'],
    ['AMOX500CA', 'Amoxicillin Capsule, 500mg', 'Amoxicillin', '500mg', 'Capsule', 'Antibiotics', 'capsule', '1.45'],
  ]

  return await writeExcelFile([headers, ...sample]).toBlob()
}
