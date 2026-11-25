// Builds the two monthly NHIS spreadsheets from a month's claims:
//   1. the claim summary, laid out like the NHIA CLAIM-it "EXCEL SUMMARY" (sheets ALL CLAIMS + SUMMARY), and
//   2. the pharmacy working sheet (the shorter list staff edit and attach paper numbers to).
// Everything here is plain data in, plain sheet data out, so it can be tested without a browser.

export const REPORT_COUNTED_STATUSES = ['served', 'submitted', 'paid']

// CLAIM-it marks anyone under 12 on the service date as a child (C), everyone else as an adult (A).
// Worked out from a real April 2026 CLAIM-it summary: youngest adult 12, oldest child 11.
export const ADULT_AGE_YEARS = 12

const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
]

const text = (value) => String(value ?? '').trim()

const parseIsoDate = (value) => {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

// A Date at UTC midnight: the Excel writer turns it into an exact day number, so no time zone can move the day.
export const toReportDate = (value) => {
  const parts = parseIsoDate(value)
  return parts ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day)) : null
}

export const formatReportDate = (value) => {
  const parts = parseIsoDate(value)
  if (!parts) return ''
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${parts.year}`
}

export const getAgeOnDate = (dateOfBirth, serviceDate) => {
  const dob = parseIsoDate(dateOfBirth)
  const service = parseIsoDate(serviceDate)
  if (!dob || !service) return null
  let age = service.year - dob.year
  if (service.month < dob.month || (service.month === dob.month && service.day < dob.day)) age -= 1
  return age
}

export const getClaimAgeGroup = (dateOfBirth, serviceDate) => {
  const age = getAgeOnDate(dateOfBirth, serviceDate)
  if (age === null || age < 0) return ''
  return age < ADULT_AGE_YEARS ? 'C' : 'A'
}

export const normalizeReportGender = (value) => {
  const first = text(value).charAt(0).toUpperCase()
  return first === 'M' || first === 'F' ? first : ''
}

export const formatReportMonth = (yearMonth, { short = false } = {}) => {
  const match = text(yearMonth).match(/^(\d{4})-(\d{2})$/)
  if (!match) return ''
  const name = MONTH_NAMES[Number(match[2]) - 1]
  if (!name) return ''
  return `${short ? name.slice(0, 3) : name} ${match[1]}`
}

const cleanMoney = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? Number(number.toFixed(4)) : 0
}

const sumLines = (lines) =>
  (Array.isArray(lines) ? lines : []).reduce((sum, line) => sum + (Number(line?.total_amount) || 0), 0)

// Pharmacy claims are medicine claims: the amount is the claim total less any tariff service lines.
export const splitClaimAmounts = (claim = {}) => {
  const medicineLines = sumLines(claim.nhis_claim_medicines)
  const services = cleanMoney(sumLines(claim.nhis_claim_services))
  const hasTotal = claim.total_amount !== null && claim.total_amount !== undefined && text(claim.total_amount) !== ''
  const rawTotal = Number(claim.total_amount)
  const total = cleanMoney(hasTotal && Number.isFinite(rawTotal) ? rawTotal : medicineLines + services)
  const pharmacy = cleanMoney(Math.max(0, total - services))
  return { services, pharmacy, investigations: 0, total }
}

export const isReportClaim = (claim = {}) =>
  REPORT_COUNTED_STATUSES.includes(text(claim.status).toLowerCase())

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Same order every time: service date, then when the claim was created, then claim number.
export const sortClaimsForReport = (claims = []) =>
  [...claims].sort((a, b) =>
    compareText(text(a.service_date_from), text(b.service_date_from)) ||
    compareText(text(a.created_at), text(b.created_at)) ||
    compareText(text(a.claim_number), text(b.claim_number)) ||
    compareText(text(a.id), text(b.id))
  )

// The claims that go in the summary, numbered 1..N. The working sheet keeps these same numbers, so a claim
// the pharmacy leaves out of the working sheet leaves a gap, exactly as in the pharmacy's own sheets.
export const buildNumberedReportClaims = (claims = []) => {
  const counted = sortClaimsForReport(claims.filter(isReportClaim))
  return counted.map((claim, index) => ({ number: index + 1, claim, amounts: splitClaimAmounts(claim) }))
}

export const countClaimsLeftOut = (claims = []) => claims.filter((claim) => !isReportClaim(claim)).length

const MONTHS_LISTED = 24

// The current month and the 23 before it, newest first. The month that is already chosen is always included.
export const buildMonthOptions = (selected) => {
  const now = new Date()
  const options = []
  for (let back = 0; back < MONTHS_LISTED; back += 1) {
    const date = new Date(Date.UTC(now.getFullYear(), now.getMonth() - back, 1))
    options.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  if (/^\d{4}-\d{2}$/.test(selected) && !options.includes(selected)) {
    options.push(selected)
    options.sort().reverse()
  }
  return options
}

// ── look ───────────────────────────────────────────────────────────────────────────────────────────────────
const NAVY = '#1F4E78'
const GRID = '#C9D3DF'
const BAND = '#F3F7FB'
const TOTAL_FILL = '#DDEBF7'
const MONEY = '#,##0.00'
const DATE_FORMAT = 'dd/mm/yyyy'

const bodyCell = (value, rowIndex, extra = {}) => {
  const base = { borderColor: GRID, alignVertical: 'center', ...(rowIndex % 2 === 1 ? { backgroundColor: BAND } : {}), ...extra }
  if (value === '' || value === null || value === undefined) return { value: '', ...base }
  return { value, ...base }
}
const textCell = (value, rowIndex, extra = {}) => bodyCell(text(value), rowIndex, extra)
const numberCell = (value, rowIndex, extra = {}) => ({ ...bodyCell(Number(value), rowIndex, { align: 'right', format: MONEY, ...extra }), type: Number })
const dateCell = (value, rowIndex, extra = {}) => {
  const date = toReportDate(value)
  if (!date) return textCell('', rowIndex, extra)
  return { ...bodyCell(date, rowIndex, { align: 'center', format: DATE_FORMAT, ...extra }), type: Date }
}
const headerCell = (value) => ({
  value, fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: NAVY, align: 'center', alignVertical: 'center',
  wrap: true, borderColor: NAVY,
})
const bannerCell = (value, columnSpan, size = 14) => ({
  value, fontWeight: 'bold', fontSize: size, textColor: NAVY, align: 'center', alignVertical: 'center', columnSpan,
})
const totalCell = (value, extra = {}) => ({
  value, fontWeight: 'bold', backgroundColor: TOTAL_FILL, borderColor: NAVY, alignVertical: 'center', ...extra,
})
const totalMoney = (value) => ({ ...totalCell(Number(value), { align: 'right', format: MONEY }), type: Number })
const blanks = (count) => Array.from({ length: Math.max(0, count) }, () => null)

const facilityTitle = (facilityName) => text(facilityName).toUpperCase() || 'PHARMACY'

// ── 1. claim summary (CLAIM-it "EXCEL SUMMARY" layout) ─────────────────────────────────────────────────────
const CLAIMS_HEADERS = [
  'No', 'SURNAME', 'OTHER NAMES', 'DOB', 'GENDER', 'ADMISSION', 'DISCHARGE', 'FOLDER NO.', 'MEMBER NO.', 'CCC',
  'PROCEDURES', 'ICD10', 'DIAGNOSES', 'GDRG', 'SERVICES (GHC)', 'PHARMACY (GHC)', 'INVESTIGATIONS (GHC)',
  'TOTAL (GHC)', 'SPECIALTY', 'AGE GROUP', 'TOS', 'SPECIALTY2',
]
const CLAIMS_WIDTHS = [7, 18, 26, 12, 9, 13, 13, 14, 15, 10, 14, 10, 18, 10, 15, 16, 19, 15, 11, 11, 8, 12]

export const buildClaimSummarySheets = ({ claims = [], facilityName = '', yearMonth = '' } = {}) => {
  const numbered = buildNumberedReportClaims(claims)
  const title = facilityTitle(facilityName)
  const monthLabel = formatReportMonth(yearMonth, { short: true })
  const columnCount = CLAIMS_HEADERS.length

  const claimRows = numbered.map(({ number, claim, amounts }, index) => {
    const serviceFrom = claim.service_date_from
    const serviceTo = claim.service_date_to || claim.service_date_from
    return [
      { ...bodyCell(number, index, { align: 'center' }), type: Number },
      textCell(claim.surname, index),
      textCell(claim.other_names, index),
      dateCell(claim.date_of_birth, index),
      textCell(normalizeReportGender(claim.gender), index, { align: 'center' }),
      dateCell(serviceFrom, index),
      dateCell(serviceTo, index),
      textCell(claim.folder_no, index),
      textCell(claim.member_no, index),
      textCell(claim.ccc_no, index, { align: 'center' }),
      textCell('', index),
      textCell('', index),
      textCell('', index),
      textCell('', index),
      numberCell(amounts.services, index),
      numberCell(amounts.pharmacy, index),
      numberCell(amounts.investigations, index),
      numberCell(amounts.total, index),
      textCell('PHC', index, { align: 'center' }),
      textCell(getClaimAgeGroup(claim.date_of_birth, serviceFrom), index, { align: 'center' }),
      textCell('PHC', index, { align: 'center' }),
      textCell('', index),
    ]
  })

  const rawTotals = numbered.reduce(
    (sum, { amounts }) => ({
      services: sum.services + amounts.services,
      pharmacy: sum.pharmacy + amounts.pharmacy,
      investigations: sum.investigations + amounts.investigations,
      total: sum.total + amounts.total,
    }),
    { services: 0, pharmacy: 0, investigations: 0, total: 0 }
  )
  const totals = {
    services: cleanMoney(rawTotals.services),
    pharmacy: cleanMoney(rawTotals.pharmacy),
    investigations: cleanMoney(rawTotals.investigations),
    total: cleanMoney(rawTotals.total),
  }
  const attendance = numbered.length

  const totalRow = [
    totalCell('TOTAL', { align: 'center' }),
    totalCell(`${attendance} claim${attendance === 1 ? '' : 's'}`),
    ...blanks(12).map(() => totalCell('')),
    totalMoney(totals.services),
    totalMoney(totals.pharmacy),
    totalMoney(totals.investigations),
    totalMoney(totals.total),
    ...blanks(4).map(() => totalCell('')),
  ]

  const claimsSheet = {
    sheet: 'ALL CLAIMS',
    data: [
      [bannerCell(title, columnCount), ...blanks(columnCount - 1)],
      [bannerCell(monthLabel, columnCount, 12), ...blanks(columnCount - 1)],
      CLAIMS_HEADERS.map(headerCell),
      ...claimRows,
      totalRow,
    ],
    columns: CLAIMS_WIDTHS.map((width) => ({ width })),
    stickyRowsCount: 3,
    orientation: 'landscape',
  }

  const summaryColumns = 5
  const summaryHeaders = ['MDC', 'ATTENDANCE', 'SERVICES', 'MEDICINES', 'TOTAL (GHC)']
  const summarySheet = {
    sheet: 'SUMMARY',
    data: [
      [bannerCell(title, summaryColumns), ...blanks(summaryColumns - 1)],
      [bannerCell('PHC', summaryColumns, 12), ...blanks(summaryColumns - 1)],
      summaryHeaders.map(headerCell),
      [
        textCell('PHC', 0, { align: 'center' }),
        { ...bodyCell(attendance, 0, { align: 'center' }), type: Number },
        numberCell(totals.services, 0),
        numberCell(totals.pharmacy, 0),
        numberCell(totals.total, 0),
      ],
      [
        totalCell('TOTAL', { align: 'center' }),
        { ...totalCell(attendance, { align: 'center' }), type: Number },
        totalMoney(totals.services),
        totalMoney(totals.pharmacy),
        totalMoney(totals.total),
      ],
      blanks(summaryColumns),
      [
        totalCell('GRAND TOTAL', { align: 'center' }),
        { ...totalCell(attendance, { align: 'center' }), type: Number },
        totalMoney(totals.services),
        totalMoney(totals.pharmacy),
        totalMoney(totals.total),
      ],
    ],
    columns: [{ width: 16 }, { width: 14 }, { width: 16 }, { width: 18 }, { width: 18 }],
    stickyRowsCount: 3,
  }

  return { sheets: [claimsSheet, summarySheet], attendance, totals }
}

// ── 2. pharmacy working sheet ──────────────────────────────────────────────────────────────────────────────
const WORKING_HEADERS = [
  'NO.', 'SURNAME', 'OTHER NAMES', 'DOB', 'GENDER', 'DATE OF SERVICE', 'DISCHARGE', 'FOLDER NUMBER',
  'MEMBERSHIP NUMBER', 'CCC', 'AMOUNT', 'ATTACHMENT NO',
]
const WORKING_WIDTHS = [7, 18, 26, 13, 9, 16, 13, 17, 20, 11, 14, 16]

export const cleanAttachmentNumber = (value) => text(value).slice(0, 24)

// Staff type the number printed on each paper attachment. It is written as text so a number such as 0380 keeps
// its leading zero.
export const buildWorkingSheet = ({
  claims = [], facilityName = '', yearMonth = '', excludedIds = [], attachmentNumbers = {},
} = {}) => {
  const excluded = new Set((excludedIds || []).map(String))
  const included = buildNumberedReportClaims(claims).filter(({ claim }) => !excluded.has(String(claim.id)))
  const columnCount = WORKING_HEADERS.length
  const banner = `${facilityTitle(facilityName)} · ${formatReportMonth(yearMonth)}`.replace(/ · $/, '')

  const rows = included.map(({ number, claim, amounts }, index) => {
    const serviceFrom = claim.service_date_from
    const serviceTo = claim.service_date_to || claim.service_date_from
    return [
      { ...bodyCell(number, index, { align: 'center' }), type: Number },
      textCell(claim.surname, index),
      textCell(claim.other_names, index),
      dateCell(claim.date_of_birth, index),
      textCell(normalizeReportGender(claim.gender), index, { align: 'center' }),
      dateCell(serviceFrom, index),
      dateCell(serviceTo, index),
      textCell(claim.folder_no, index),
      textCell(claim.member_no, index),
      textCell(claim.ccc_no, index, { align: 'center' }),
      numberCell(amounts.pharmacy, index),
      textCell(cleanAttachmentNumber(attachmentNumbers?.[claim.id]), index, { align: 'center' }),
    ]
  })

  const totalAmount = cleanMoney(included.reduce((sum, { amounts }) => sum + amounts.pharmacy, 0))
  const totalRow = [
    totalCell('TOTAL', { align: 'center' }),
    totalCell(`${included.length} claim${included.length === 1 ? '' : 's'}`),
    ...blanks(8).map(() => totalCell('')),
    totalMoney(totalAmount),
    totalCell(''),
  ]

  return {
    sheets: [{
      sheet: 'Claims',
      data: [
        WORKING_HEADERS.map(headerCell),
        [null, bannerCell(banner, columnCount - 1, 12), ...blanks(columnCount - 2)],
        ...rows,
        totalRow,
      ],
      columns: WORKING_WIDTHS.map((width) => ({ width })),
      stickyRowsCount: 2,
      orientation: 'landscape',
    }],
    count: included.length,
    totalAmount,
  }
}

// ── file names ─────────────────────────────────────────────────────────────────────────────────────────────
const safeFilePart = (value) => text(value).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()

export const buildReportFileName = (kind, facilityName, yearMonth) => {
  const facility = safeFilePart(facilityName) || 'Pharmacy'
  const month = formatReportMonth(yearMonth, { short: true }) || safeFilePart(yearMonth)
  const label = kind === 'working' ? 'working sheet' : 'claim summary'
  return `${facility} ${label} ${month}.xlsx`.replace(/\s+/g, ' ')
}

// ── remembering the staff's ticks and typed numbers, per pharmacy and month, in this browser only ─────────────
export const reportSelectionKey = (organizationId, yearMonth) =>
  `healthflow.nhisMonthlyReports.v1:${text(organizationId) || 'org'}:${text(yearMonth)}`

export const loadReportSelection = (storage, organizationId, yearMonth) => {
  try {
    const raw = storage?.getItem(reportSelectionKey(organizationId, yearMonth))
    const parsed = raw ? JSON.parse(raw) : null
    const excludedIds = Array.isArray(parsed?.excludedIds) ? parsed.excludedIds.map(String) : []
    const attachmentNumbers = parsed?.attachmentNumbers && typeof parsed.attachmentNumbers === 'object' && !Array.isArray(parsed.attachmentNumbers)
      ? Object.fromEntries(Object.entries(parsed.attachmentNumbers).map(([id, value]) => [id, cleanAttachmentNumber(value)]))
      : {}
    return { excludedIds, attachmentNumbers }
  } catch {
    return { excludedIds: [], attachmentNumbers: {} }
  }
}

export const saveReportSelection = (storage, organizationId, yearMonth, selection) => {
  try {
    const attachmentNumbers = Object.fromEntries(
      Object.entries(selection?.attachmentNumbers || {})
        .map(([id, value]) => [id, cleanAttachmentNumber(value)])
        .filter(([, value]) => value)
    )
    storage?.setItem(
      reportSelectionKey(organizationId, yearMonth),
      JSON.stringify({ excludedIds: (selection?.excludedIds || []).map(String), attachmentNumbers })
    )
    return true
  } catch {
    return false
  }
}

// The same look (header colours, banding, number formats) is reused by the medicine search workbook.
export const reportSheetKit = {
  text, cleanMoney, bodyCell, textCell, numberCell, dateCell, headerCell, bannerCell, totalCell, totalMoney, blanks,
  facilityTitle, safeFilePart, MONEY,
}
