// Purchase order bulk import (Excel/CSV): pure parsing/validation/matching logic, framework-free so it can be
// unit-tested without mounting the Purchases page. The Purchases page owns file I/O (read-excel-file, FileReader)
// and React state; this module only ever produces the same line-item shape addLineItem() already builds by hand
// (drugId, drugName, brandName, genericName, unit, quantity, unitCost, discountType, discountAmount,
// discountPercent, netTotal, saleOnReturn, batchNumber, expiryDate), and reuses the page's own total/discount
// calculators so manual and imported rows are computed identically.
//
// Import never talks to the database, never resolves a purchase draft, and never calls complete_purchase — it only
// produces rows for the caller to push into the same lineItems array manual entry already writes to. Stock only
// ever changes through the existing receive/complete flow, which this file has no access to.
import { assertRequiredText, assertNonNegativeNumber, normalizeText, toNumber } from './validation'

export const PURCHASE_IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB — a purchase workbook can run larger than a single-column drug list
export const PURCHASE_IMPORT_MAX_ROWS = 1000

export const PURCHASE_IMPORT_ROW_STATUS = Object.freeze({
  VALID: 'valid',
  WARNING: 'warning', // importable, but worth a second look (unmatched product, unit fallback, ...)
  INVALID: 'invalid', // not importable until fixed
})

// Column order for the downloadable template and the header aliases accepted on the way in. Every column maps to
// an existing purchase-item field; nothing here is invented for the spreadsheet.
export const PURCHASE_IMPORT_COLUMNS = [
  { key: 'drugName', header: 'Drug / Item', aliases: ['drug', 'item', 'drug/item', 'drug name', 'product', 'medicine'] },
  { key: 'brandName', header: 'Brand Name', aliases: ['brand'] },
  { key: 'genericName', header: 'Generic Name', aliases: ['generic'] },
  { key: 'unit', header: 'Unit', aliases: [] },
  { key: 'quantity', header: 'Qty', aliases: ['quantity'] },
  { key: 'unitCost', header: 'Unit Cost', aliases: ['cost', 'unit price', 'price'] },
  { key: 'discountPercent', header: 'Discount %', aliases: ['discount', 'discount percent', 'discount(%)'] },
  { key: 'batchNumber', header: 'Batch No.', aliases: ['batch', 'batch number', 'batch no'] },
  { key: 'expiryDate', header: 'Expiry Date', aliases: ['expiry', 'expiry date', 'exp date', 'exp'] },
  { key: 'saleOnReturn', header: 'Sale on Return', aliases: ['sale on return?'] },
]
const REQUIRED_COLUMN_KEYS = ['drugName', 'quantity', 'unitCost']

const normalizeHeaderCell = (value) => normalizeText(value).toLowerCase().replace(/[.]/g, '').trim()

const HEADER_TO_KEY = new Map()
PURCHASE_IMPORT_COLUMNS.forEach(({ key, header, aliases }) => {
  HEADER_TO_KEY.set(normalizeHeaderCell(header), key)
  aliases.forEach((alias) => HEADER_TO_KEY.set(normalizeHeaderCell(alias), key))
})

/**
 * Maps a parsed header row to canonical field keys. Unknown extra columns are ignored (never executed, never
 * trusted); a required column that never matched, or a header cell that maps to a key already claimed by an
 * earlier column (a duplicate), is reported so the caller can show one clear error instead of guessing.
 */
export const mapPurchaseImportHeaders = (headerRow = []) => {
  const keyByColumnIndex = []
  const seenKeys = new Set()
  const duplicateKeys = new Set()

  headerRow.forEach((cell) => {
    const key = HEADER_TO_KEY.get(normalizeHeaderCell(cell)) || null
    if (key) {
      if (seenKeys.has(key)) duplicateKeys.add(key)
      seenKeys.add(key)
    }
    keyByColumnIndex.push(key)
  })

  const missing = REQUIRED_COLUMN_KEYS.filter((key) => !seenKeys.has(key))
  return { keyByColumnIndex, missing, duplicates: [...duplicateKeys] }
}

const rowArrayToObject = (row, keyByColumnIndex) => {
  const object = {}
  keyByColumnIndex.forEach((key, index) => {
    if (key) object[key] = row[index]
  })
  return object
}

/**
 * Turns a sheet's rows (first row = header, as returned by read-excel-file's readSheet, or by parsePurchaseImportCsv)
 * into { drugName, quantity, ... } objects keyed by the canonical field names above. Throws with a specific,
 * actionable message rather than a bare "Import failed" for anything that isn't row-level (empty file, missing
 * columns, duplicate columns, too many rows).
 */
export const purchaseImportRowsToObjects = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The file is empty.')
  }
  const [headerRow, ...dataRows] = rows
  const { keyByColumnIndex, missing, duplicates } = mapPurchaseImportHeaders(headerRow)
  if (missing.length) {
    const labels = PURCHASE_IMPORT_COLUMNS.filter((column) => missing.includes(column.key)).map((column) => column.header)
    throw new Error(`Missing required column${labels.length === 1 ? '' : 's'}: ${labels.join(', ')}.`)
  }
  if (duplicates.length) {
    const labels = PURCHASE_IMPORT_COLUMNS.filter((column) => duplicates.includes(column.key)).map((column) => column.header)
    throw new Error(`Duplicate column${labels.length === 1 ? '' : 's'}: ${labels.join(', ')}. Each column should appear once.`)
  }
  const trimmedRows = dataRows.filter((row) => (row || []).some((cell) => normalizeText(cell) !== ''))
  if (trimmedRows.length === 0) {
    throw new Error('The file has a header row but no data rows.')
  }
  if (trimmedRows.length > PURCHASE_IMPORT_MAX_ROWS) {
    throw new Error(`This file has ${trimmedRows.length} rows. Import up to ${PURCHASE_IMPORT_MAX_ROWS} rows at a time — split larger files.`)
  }
  return trimmedRows.map((row) => rowArrayToObject(row, keyByColumnIndex))
}

// ---- CSV -----------------------------------------------------------------------------------------------------
// read-excel-file (already a dependency, used by the existing Inventory bulk import) only reads .xlsx. CSV here is
// flat, simple purchase rows, so a small RFC4180-style parser (quoted fields, escaped "" quotes, quoted commas and
// newlines) covers it without adding a new dependency.
export const parsePurchaseImportCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const source = String(text ?? '').replace(/^\ufeff/, '') // strip a UTF-8 BOM from Excel-exported CSVs

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1 } else { inQuotes = false }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') { inQuotes = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((line) => line.length > 1 || normalizeText(line[0]) !== '')
}

// ---- row validation --------------------------------------------------------------------------------------------
const TRUE_WORDS = new Set(['true', 'yes', 'y', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', ''])

const parseImportedBoolean = (value) => {
  if (typeof value === 'boolean') return { value, ok: true }
  const normalized = normalizeText(value).toLowerCase()
  if (TRUE_WORDS.has(normalized)) return { value: true, ok: true }
  if (FALSE_WORDS.has(normalized)) return { value: false, ok: true }
  return { value: false, ok: false }
}

// Accepts only what is unambiguous: a real Date (read-excel-file returns JS Dates for date-formatted xlsx cells) or
// an ISO yyyy-mm-dd string (what the page's own <input type="date"> produces and stores). A locale-ambiguous string
// like "03/04/2027" is rejected rather than guessed at — a wrong expiry date is a patient-safety issue.
const parseImportedDate = (value) => {
  const normalized = normalizeText(value)
  if (!normalized && !(value instanceof Date)) return { value: null, ok: true }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { value: value.toISOString().slice(0, 10), ok: true }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const parsed = new Date(`${normalized}T00:00:00Z`)
    if (!Number.isNaN(parsed.getTime())) return { value: normalized, ok: true }
  }
  return { value: null, ok: false }
}

/**
 * Finds the best existing inventory match for an imported drug name. Matching is a convenience (auto-fills brand,
 * generic name and unit the same way clicking a drug in the manual-entry search does) — it is never a gate. The
 * app's own manual entry lets a typed drug name with no match through as a perfectly valid line (a new batch of a
 * catalogued drug is often typed by hand), so import holds imported rows to the same standard: an unmatched name is
 * a warning to double-check spelling, not a blocked row. Several existing rows sharing the exact name is normal
 * here (each batch is its own row) — it is not treated as an unresolved ambiguity; drugId is only set when exactly
 * one existing drug shares the name, otherwise it is left null exactly as a hand-typed, unselected name would be.
 */
export const matchPurchaseImportDrug = (drugName, drugs = []) => {
  const target = normalizeText(drugName).toLowerCase()
  if (!target) return { status: 'unmatched', drugId: null, candidates: [] }
  const candidates = drugs.filter((drug) => normalizeText(drug.name).toLowerCase() === target)
  if (!candidates.length) return { status: 'unmatched', drugId: null, candidates: [] }
  const distinctIds = new Set(candidates.map((drug) => drug.id))
  return {
    status: 'matched',
    drugId: distinctIds.size === 1 ? candidates[0].id : null,
    candidates,
  }
}

/**
 * Validates and normalizes one imported row into the same shape addLineItem() builds by hand, ready to push
 * straight into the purchase draft's lineItems. `allowedUnits` is the page's own unit list (never duplicated here)
 * so an unrecognized unit is a warning with a safe fallback, not a second source of truth for what a unit is.
 */
export const validatePurchaseImportRow = (row, { drugs = [], allowedUnits = [], fallbackUnit = 'tablet' } = {}) => {
  const issues = []
  let status = PURCHASE_IMPORT_ROW_STATUS.VALID

  const raise = (message, blocking = true) => {
    issues.push(message)
    if (blocking) status = PURCHASE_IMPORT_ROW_STATUS.INVALID
    else if (status !== PURCHASE_IMPORT_ROW_STATUS.INVALID) status = PURCHASE_IMPORT_ROW_STATUS.WARNING
  }

  let drugName = ''
  try {
    drugName = assertRequiredText(row.drugName, 'Drug / Item')
  } catch (error) {
    raise(error.message)
  }

  let quantity = 0
  try {
    quantity = assertNonNegativeNumber(row.quantity, 'Qty')
    if (quantity <= 0) raise('Qty must be greater than zero.')
  } catch (error) {
    raise(error.message)
  }

  let unitCost = 0
  try {
    unitCost = assertNonNegativeNumber(row.unitCost, 'Unit Cost')
  } catch (error) {
    raise(error.message)
  }

  let discountPercent = 0
  const rawDiscount = normalizeText(row.discountPercent)
  if (rawDiscount) {
    discountPercent = toNumber(row.discountPercent, Number.NaN)
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      raise('Discount % must be a number between 0 and 100.')
      discountPercent = 0
    }
  }

  const normalizedUnitInput = normalizeText(row.unit)
  let unit = fallbackUnit
  if (normalizedUnitInput) {
    const match = allowedUnits.find((value) => value.toLowerCase() === normalizedUnitInput.toLowerCase())
    if (match) unit = match
    else raise(`Unit "${normalizedUnitInput}" is not recognized — used "${fallbackUnit}" instead. Fix it in the preview if needed.`, false)
  }

  const dateResult = parseImportedDate(row.expiryDate)
  if (!dateResult.ok) raise('Expiry Date must be a date, in YYYY-MM-DD format.')

  const saleOnReturnCell = row.saleOnReturn
  const saleOnReturnResult = parseImportedBoolean(saleOnReturnCell)
  if (!saleOnReturnResult.ok) raise(`Sale on Return "${saleOnReturnCell}" was not recognized — treated as No.`, false)

  const match = matchPurchaseImportDrug(drugName, drugs)
  if (match.status === 'unmatched' && drugName) {
    raise(`No existing medicine named "${drugName}" — check the spelling, or import it anyway as a new line.`, false)
  }
  const bestCandidate = match.candidates[0] || null

  const item = {
    drugId: match.drugId,
    drugName,
    brandName: normalizeText(row.brandName) || normalizeText(bestCandidate?.brand_name) || '',
    genericName: normalizeText(row.genericName) || normalizeText(bestCandidate?.generic_name) || '',
    unit,
    quantity,
    unitCost,
    discountType: 'percent',
    discountPercent,
    saleOnReturn: saleOnReturnResult.value,
    batchNumber: normalizeText(row.batchNumber),
    expiryDate: dateResult.value || '',
  }

  return { status, issues, item, matchStatus: match.status, matchCandidates: match.candidates }
}

/**
 * Finalizes a validated row's totals using the exact same discount/net-total calculators the manual entry panel
 * uses, so an imported line and a hand-typed line with the same numbers always compute identically.
 */
export const finalizePurchaseImportItem = (item, { calcDiscountValue, calcNetTotal }) => {
  const discountAmount = calcDiscountValue(item.quantity, item.unitCost, 'percent', item.discountPercent)
  const netTotal = calcNetTotal(item.quantity, item.unitCost, 'percent', item.discountPercent)
  return { ...item, discountAmount, netTotal }
}

/**
 * Groups rows that are identical in every field that matters (product, batch, expiry, cost, discount, sale-on-
 * return) so the caller can offer to combine their quantities. Rows differing in any of those stay separate lines
 * — combining across a different batch or cost would silently change what was actually purchased.
 */
export const groupDuplicatePurchaseImportRows = (validItems) => {
  const groups = new Map()
  validItems.forEach((entry, index) => {
    const item = entry.item
    const key = JSON.stringify([
      normalizeText(item.drugName).toLowerCase(),
      normalizeText(item.batchNumber).toLowerCase(),
      item.expiryDate || '',
      item.unitCost,
      item.discountPercent,
      item.unit,
      item.saleOnReturn,
    ])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(index)
  })
  return [...groups.values()].filter((indexes) => indexes.length > 1)
}
