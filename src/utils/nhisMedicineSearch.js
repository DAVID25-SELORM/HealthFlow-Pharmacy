// "Which patients were given these medicines?" for NHIS claims.
// Plain data in, plain data out (and plain Excel sheet data), so it can be tested without a browser.
//
// A search is a typed list such as   Paclitaxel, Docetaxel, Xeloda (Capecitabine), Anastrozole (Arimidex), Tamoxifen
// Every entry is one medicine. Names in brackets, or separated by "/", are other names for the same medicine
// (brand and generic), so a claim line matching any of them counts under that entry.

import {
  REPORT_COUNTED_STATUSES, formatReportDate, formatReportMonth, normalizeReportGender, reportSheetKit,
} from './nhisMonthlyReports'

const {
  text, cleanMoney, bodyCell, textCell, numberCell, dateCell, headerCell, bannerCell, totalCell, totalMoney, blanks,
  facilityTitle, safeFilePart,
} = reportSheetKit

export const MIN_TERM_LENGTH = 3
export const MAX_MEDICINES = 20

// ── reading the typed list ─────────────────────────────────────────────────────────────────────────────────
const splitOutsideBrackets = (value) => {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of String(value ?? '')) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === ',' || char === ';' || char === '\n' || char === '\r')) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

// Characters that would break the cloud search text are never part of a medicine name.
const cleanTerm = (value) => text(value).replace(/[,()[\]%*"'\\;]/g, ' ').replace(/\s+/g, ' ').trim()

export const parseMedicineSearch = (input) => {
  const groups = []
  const ignored = []
  const seen = new Set()

  for (const entry of splitOutsideBrackets(input)) {
    const outside = entry.replace(/[([][^)\]]*[)\]]/g, ' ')
    const inside = [...entry.matchAll(/[([]([^)\]]*)[)\]]/g)].map((match) => match[1])
    const names = [...outside.split('/'), ...inside.flatMap((part) => part.split(/[/;,]|\sor\s/i))]
      .map(cleanTerm)
      .filter(Boolean)
    const terms = [...new Set(names.filter((name) => name.length >= MIN_TERM_LENGTH).map((name) => name.toLowerCase()))]
    if (!terms.length) { ignored.push(entry); continue }
    const label = entry.replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ')').replace(/\s+/g, ' ').trim()
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    groups.push({ label, terms })
  }

  return { groups: groups.slice(0, MAX_MEDICINES), ignored, tooMany: groups.length > MAX_MEDICINES }
}

export const allSearchTerms = (groups = []) => [...new Set(groups.flatMap((group) => group.terms))]

// ── months ─────────────────────────────────────────────────────────────────────────────────────────────────
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/

export const monthRangeToDates = (fromMonth, toMonth) => {
  const from = text(fromMonth).match(MONTH_PATTERN)
  const to = text(toMonth).match(MONTH_PATTERN)
  if (!from || !to) return null
  let [startYear, startMonth] = [Number(from[1]), Number(from[2])]
  let [endYear, endMonth] = [Number(to[1]), Number(to[2])]
  if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return null
  if (startYear * 12 + startMonth > endYear * 12 + endMonth) {
    [startYear, startMonth, endYear, endMonth] = [endYear, endMonth, startYear, startMonth]
  }
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    fromMonth: `${startYear}-${pad(startMonth)}`,
    toMonth: `${endYear}-${pad(endMonth)}`,
    fromDate: `${startYear}-${pad(startMonth)}-01`,
    toDate: `${endYear}-${pad(endMonth)}-${pad(lastDay)}`,
  }
}

export const formatSearchPeriod = (fromMonth, toMonth, { short = false } = {}) => {
  const range = monthRangeToDates(fromMonth, toMonth)
  if (!range) return ''
  const first = formatReportMonth(range.fromMonth, { short })
  const last = formatReportMonth(range.toMonth, { short })
  return first === last ? first : `${first} to ${last}`
}

// ── matching claim lines ───────────────────────────────────────────────────────────────────────────────────
const toNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

// What the patient actually received: the served quantity when the claim records one, otherwise the dispensed one.
export const getGivenQuantity = (line = {}) => {
  const served = toNumber(line.served_qty)
  return served > 0 ? served : toNumber(line.dispensed_qty)
}

const getLineAmount = (line = {}) => {
  const explicit = line.total_amount
  if (explicit !== null && explicit !== undefined && text(explicit) !== '' && Number.isFinite(Number(explicit))) return cleanMoney(explicit)
  return cleanMoney(getGivenQuantity(line) * toNumber(line.unit_price))
}

const patientKeyOf = (claim = {}) => {
  const member = text(claim.member_no).toUpperCase().replace(/\s+/g, '')
  if (member) return `member:${member}`
  const folder = text(claim.folder_no).toUpperCase().replace(/\s+/g, '')
  if (folder) return `folder:${folder}`
  const patientId = text(claim.patient_id)
  if (patientId) return `patient:${patientId}`
  return `name:${[claim.surname, claim.other_names, claim.date_of_birth].map((part) => text(part).toLowerCase()).join('|')}`
}

const lineMatches = (line, group) => {
  const description = text(line.description).toLowerCase()
  return group.terms.some((term) => description.includes(term))
}

const compareText = (left, right) => String(left ?? '').localeCompare(String(right ?? ''), 'en', { sensitivity: 'base' })

const formatQuantity = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)))
}

export const buildMedicineSearchResult = ({ lines = [], groups = [] } = {}) => {
  const counted = new Set(REPORT_COUNTED_STATUSES)
  const details = []
  const patientMap = new Map()
  const groupMap = new Map(groups.map((group) => [group.label, {
    label: group.label, patientKeys: new Set(), claimIds: new Set(), quantity: 0, amount: 0,
  }]))
  const allClaimIds = new Set()
  let totalAmount = 0
  let walkInLines = 0

  for (const line of lines) {
    const claim = line?.claim || {}
    const isCash = line?.source === 'cash'
    // Cash sale lines arrive already limited to completed sales; claim lines must be served, submitted or paid.
    if (!isCash && !counted.has(text(claim.status).toLowerCase())) continue
    const quantity = getGivenQuantity(line)
    if (quantity <= 0) continue
    const matched = groups.filter((group) => lineMatches(line, group))
    if (!matched.length) continue
    if (isCash && line.hasPatient === false) { walkInLines += 1; continue }

    const amount = getLineAmount(line)
    const patientKey = patientKeyOf(claim)
    const source = isCash ? 'cash' : 'nhis'
    const date = line.dispensary_date || claim.service_date_from || ''
    const recordId = `${source}:${claim.id ?? line.claim_id ?? ''}`

    details.push({
      date, claim, line, quantity, amount, patientKey, source,
      searchedAs: matched.map((group) => group.label).join(' / '),
    })
    allClaimIds.add(recordId)
    totalAmount += amount

    let patient = patientMap.get(patientKey)
    if (!patient) {
      patient = {
        key: patientKey, claim, claimIds: new Set(), medicines: new Map(), sources: new Set(),
        firstDate: date, lastDate: date, amount: 0, claimSource: source,
      }
      patientMap.set(patientKey, patient)
    }
    const claimId = recordId
    patient.claimIds.add(claimId)
    patient.sources.add(source)
    patient.amount += amount
    if (date && (!patient.firstDate || date < patient.firstDate)) patient.firstDate = date
    if (date && date > patient.lastDate) patient.lastDate = date
    // Show the name and numbers from the most recent record, preferring a claim over a sale (claims are typed
    // as on the member's card; a sale only has the patient's registered name).
    const takesOver = patient.claimSource === source ? (date && date >= patient.lastDate) : source === 'nhis'
    if (takesOver) { patient.claim = claim; patient.claimSource = source }

    for (const group of matched) {
      const medicine = patient.medicines.get(group.label) || { quantity: 0, claimIds: new Set() }
      medicine.quantity += quantity
      medicine.claimIds.add(claimId)
      patient.medicines.set(group.label, medicine)

      const summary = groupMap.get(group.label)
      summary.patientKeys.add(patientKey)
      summary.claimIds.add(claimId)
      summary.quantity += quantity
      summary.amount += amount
    }
  }

  details.sort((left, right) => compareText(left.date, right.date) || compareText(left.claim.surname, right.claim.surname))

  const order = new Map(groups.map((group, index) => [group.label, index]))
  const patients = [...patientMap.values()]
    .map((patient) => ({
      key: patient.key,
      claim: patient.claim,
      surname: text(patient.claim.surname),
      otherNames: text(patient.claim.other_names),
      memberNo: text(patient.claim.member_no),
      folderNo: text(patient.claim.folder_no),
      dateOfBirth: patient.claim.date_of_birth,
      gender: patient.claim.gender,
      claimCount: patient.claimIds.size,
      sources: ['nhis', 'cash'].filter((source) => patient.sources.has(source)),
      firstDate: patient.firstDate,
      lastDate: patient.lastDate,
      amount: cleanMoney(patient.amount),
      medicines: [...patient.medicines.entries()]
        .sort((left, right) => (order.get(left[0]) ?? 0) - (order.get(right[0]) ?? 0))
        .map(([label, medicine]) => ({ label, quantity: cleanMoney(medicine.quantity), claimCount: medicine.claimIds.size })),
    }))
    .sort((left, right) => compareText(left.surname, right.surname) || compareText(left.otherNames, right.otherNames))

  const summary = groups.map((group) => {
    const entry = groupMap.get(group.label)
    return {
      label: group.label,
      patients: entry.patientKeys.size,
      claims: entry.claimIds.size,
      quantity: cleanMoney(entry.quantity),
      amount: cleanMoney(entry.amount),
    }
  })

  return {
    summary,
    patients,
    details,
    totals: { patients: patients.length, claims: allClaimIds.size, amount: cleanMoney(totalAmount) },
    walkInLines,
  }
}

export const SOURCE_LABELS = { nhis: 'NHIS claim', cash: 'Cash sale' }
export const describeSources = (sources = []) => sources.map((source) => SOURCE_LABELS[source]).filter(Boolean).join(' + ')

export const describePatientMedicines = (patient) =>
  patient.medicines.map((medicine) => `${medicine.label} ×${formatQuantity(medicine.quantity)}`).join('; ')

// ── the workbook ───────────────────────────────────────────────────────────────────────────────────────────
const SUMMARY_HEADERS = ['MEDICINE SEARCHED', 'PATIENTS', 'CLAIMS / SALES', 'QUANTITY GIVEN', 'AMOUNT (GHC)']
const PATIENT_HEADERS = [
  'No', 'SURNAME', 'OTHER NAMES', 'DOB', 'GENDER', 'MEMBER NO.', 'FOLDER NO.', 'MEDICINES GIVEN', 'GIVEN VIA',
  'CLAIMS / SALES', 'FIRST DATE', 'LAST DATE', 'AMOUNT (GHC)',
]
const DETAIL_HEADERS = [
  'No', 'DATE', 'SURNAME', 'OTHER NAMES', 'MEMBER NO.', 'FOLDER NO.', 'CCC', 'CLAIM / SALE NO.', 'SOURCE',
  'MEDICINE AS RECORDED', 'SEARCHED AS', 'QUANTITY', 'UNIT PRICE (GHC)', 'AMOUNT (GHC)',
]

const titleRow = (title, columnCount) => [bannerCell(title, columnCount, 13), ...blanks(columnCount - 1)]

const SOURCE_HEADING = { nhis: ' · NHIS CLAIMS ONLY', cash: ' · CASH SALES ONLY' }

export const buildMedicineSearchSheets = ({
  result, groups = [], facilityName = '', fromMonth = '', toMonth = '', source = 'all',
} = {}) => {
  const safeResult = result || buildMedicineSearchResult({ lines: [], groups })
  const period = formatSearchPeriod(fromMonth, toMonth)
  const heading = `${facilityTitle(facilityName)} · PATIENTS GIVEN SELECTED MEDICINES${period ? ` · ${period}` : ''}${SOURCE_HEADING[source] || ''}`

  const summaryRows = safeResult.summary.map((entry, index) => [
    textCell(entry.label, index),
    { ...bodyCell(entry.patients, index, { align: 'center' }), type: Number },
    { ...bodyCell(entry.claims, index, { align: 'center' }), type: Number },
    { ...bodyCell(entry.quantity, index, { align: 'right', format: '#,##0.##' }), type: Number },
    numberCell(entry.amount, index),
  ])
  const summaryTotal = [
    totalCell('ALL MEDICINES (each patient counted once)'),
    { ...totalCell(safeResult.totals.patients, { align: 'center' }), type: Number },
    { ...totalCell(safeResult.totals.claims, { align: 'center' }), type: Number },
    totalCell(''),
    totalMoney(safeResult.totals.amount),
  ]

  const patientRows = safeResult.patients.map((patient, index) => [
    { ...bodyCell(index + 1, index, { align: 'center' }), type: Number },
    textCell(patient.surname, index),
    textCell(patient.otherNames, index),
    dateCell(patient.dateOfBirth, index),
    textCell(normalizeReportGender(patient.gender), index, { align: 'center' }),
    textCell(patient.memberNo, index),
    textCell(patient.folderNo, index),
    textCell(describePatientMedicines(patient), index, { wrap: true }),
    textCell(describeSources(patient.sources), index, { wrap: true }),
    { ...bodyCell(patient.claimCount, index, { align: 'center' }), type: Number },
    dateCell(patient.firstDate, index),
    dateCell(patient.lastDate, index),
    numberCell(patient.amount, index),
  ])
  const patientTotal = [
    totalCell('TOTAL', { align: 'center' }),
    totalCell(`${safeResult.totals.patients} patient${safeResult.totals.patients === 1 ? '' : 's'}`),
    ...blanks(10).map(() => totalCell('')),
    totalMoney(safeResult.totals.amount),
  ]

  const detailRows = safeResult.details.map((entry, index) => [
    { ...bodyCell(index + 1, index, { align: 'center' }), type: Number },
    dateCell(entry.date, index),
    textCell(entry.claim.surname, index),
    textCell(entry.claim.other_names, index),
    textCell(entry.claim.member_no, index),
    textCell(entry.claim.folder_no, index),
    textCell(entry.claim.ccc_no, index, { align: 'center' }),
    textCell(entry.claim.claim_number, index),
    textCell(SOURCE_LABELS[entry.source], index),
    textCell(entry.line.description, index, { wrap: true }),
    textCell(entry.searchedAs, index, { wrap: true }),
    { ...bodyCell(entry.quantity, index, { align: 'right', format: '#,##0.##' }), type: Number },
    numberCell(entry.line.unit_price, index),
    numberCell(entry.amount, index),
  ])

  const walkInNote = safeResult.walkInLines > 0
    ? [[textCell(`${safeResult.walkInLines} cash sale line${safeResult.walkInLines === 1 ? '' : 's'} with no patient recorded ${safeResult.walkInLines === 1 ? 'was' : 'were'} left out.`, 0, { wrap: false })]]
    : []

  const columns = (widths) => widths.map((width) => ({ width }))

  return [
    {
      sheet: 'SUMMARY',
      data: [titleRow(heading, SUMMARY_HEADERS.length), SUMMARY_HEADERS.map(headerCell), ...summaryRows, summaryTotal, ...walkInNote],
      columns: columns([44, 12, 12, 16, 16]),
      stickyRowsCount: 2,
      orientation: 'landscape',
    },
    {
      sheet: 'PATIENTS',
      data: [titleRow(heading, PATIENT_HEADERS.length), PATIENT_HEADERS.map(headerCell), ...patientRows, patientTotal],
      columns: columns([6, 18, 26, 12, 9, 16, 14, 52, 20, 10, 12, 12, 15]),
      stickyRowsCount: 2,
      orientation: 'landscape',
    },
    {
      sheet: 'DETAILS',
      data: [titleRow(heading, DETAIL_HEADERS.length), DETAIL_HEADERS.map(headerCell), ...detailRows],
      columns: columns([6, 12, 18, 26, 16, 14, 11, 18, 12, 44, 28, 11, 15, 15]),
      stickyRowsCount: 2,
      orientation: 'landscape',
    },
  ]
}

export const buildMedicineSearchFileName = (facilityName, fromMonth, toMonth) => {
  const facility = safeFilePart(facilityName) || 'Pharmacy'
  const period = formatSearchPeriod(fromMonth, toMonth, { short: true }) || 'period'
  return `${facility} medicine search ${period}.xlsx`.replace(/\s+/g, ' ')
}

// ── remembering the last typed list, per pharmacy, in this browser only ────────────────────────────────────
export const medicineSearchStorageKey = (organizationId) => `healthflow.nhisMedicineSearch.v1:${text(organizationId) || 'org'}`

export const loadSavedMedicineList = (storage, organizationId) => {
  try {
    const value = storage?.getItem(medicineSearchStorageKey(organizationId))
    return typeof value === 'string' ? value.slice(0, 2000) : ''
  } catch {
    return ''
  }
}

export const saveMedicineList = (storage, organizationId, value) => {
  try {
    storage?.setItem(medicineSearchStorageKey(organizationId), text(value).slice(0, 2000))
    return true
  } catch {
    return false
  }
}

export { formatReportDate }
