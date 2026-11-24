import { describe, expect, it } from 'vitest'
import {
  ADULT_AGE_YEARS,
  buildClaimSummarySheets,
  buildNumberedReportClaims,
  buildReportFileName,
  buildWorkingSheet,
  cleanAttachmentNumber,
  countClaimsLeftOut,
  formatReportDate,
  formatReportMonth,
  getAgeOnDate,
  getClaimAgeGroup,
  isReportClaim,
  loadReportSelection,
  normalizeReportGender,
  saveReportSelection,
  sortClaimsForReport,
  splitClaimAmounts,
  toReportDate,
} from './nhisMonthlyReports'

const claim = (overrides = {}) => ({
  id: 'c1',
  claim_number: 'CL-1',
  status: 'served',
  surname: 'ALPHA',
  other_names: 'ADWOA',
  gender: 'Female',
  date_of_birth: '1970-01-15',
  service_date_from: '2026-04-01',
  service_date_to: '2026-04-01',
  created_at: '2026-04-01T09:00:00Z',
  folder_no: 'F-0001',
  member_no: '10000001',
  ccc_no: '10001',
  total_amount: 125.5,
  ...overrides,
})

const flat = (sheet) => sheet.data.map((row) => row.map((cell) => (cell ? cell.value : null)))

describe('dates and age group', () => {
  it('formats ISO dates as dd/mm/yyyy and ignores bad ones', () => {
    expect(formatReportDate('2026-04-01')).toBe('01/04/2026')
    expect(formatReportDate('2026-04-01T23:30:00Z')).toBe('01/04/2026')
    expect(formatReportDate('')).toBe('')
    expect(formatReportDate('2026-13-01')).toBe('')
    expect(formatReportDate('not a date')).toBe('')
  })

  it('makes a date at UTC midnight so no time zone can move the day', () => {
    expect(toReportDate('2026-04-01').toISOString()).toBe('2026-04-01T00:00:00.000Z')
    expect(toReportDate('x')).toBeNull()
  })

  it('counts whole years, not yet having had the birthday this year', () => {
    expect(getAgeOnDate('2013-04-02', '2026-04-01')).toBe(12)
    expect(getAgeOnDate('2014-04-02', '2026-04-01')).toBe(11)
    expect(getAgeOnDate('2014-04-01', '2026-04-01')).toBe(12)
    expect(getAgeOnDate('', '2026-04-01')).toBeNull()
  })

  it('uses the CLAIM-it rule: under 12 is a child (C), 12 and over an adult (A)', () => {
    expect(ADULT_AGE_YEARS).toBe(12)
    expect(getClaimAgeGroup('2014-04-02', '2026-04-01')).toBe('C') // 11 years old
    expect(getClaimAgeGroup('2013-04-01', '2026-04-01')).toBe('A') // 13
    expect(getClaimAgeGroup('2014-04-01', '2026-04-01')).toBe('A') // exactly 12
    expect(getClaimAgeGroup('', '2026-04-01')).toBe('')
    expect(getClaimAgeGroup('2030-01-01', '2026-04-01')).toBe('')
  })

  it('names months like the CLAIM-it file', () => {
    expect(formatReportMonth('2026-04', { short: true })).toBe('APR 2026')
    expect(formatReportMonth('2026-04')).toBe('APRIL 2026')
    expect(formatReportMonth('2026-13')).toBe('')
    expect(formatReportMonth('')).toBe('')
  })

  it('reduces gender to M or F', () => {
    expect(normalizeReportGender('Female')).toBe('F')
    expect(normalizeReportGender('male')).toBe('M')
    expect(normalizeReportGender('F')).toBe('F')
    expect(normalizeReportGender('')).toBe('')
    expect(normalizeReportGender('other')).toBe('')
  })
})

describe('amounts', () => {
  it('pharmacy equals the claim total when there are no service lines', () => {
    expect(splitClaimAmounts(claim({ total_amount: 125.5 }))).toEqual({ services: 0, pharmacy: 125.5, investigations: 0, total: 125.5 })
  })

  it('takes tariff service lines out of the pharmacy amount', () => {
    const result = splitClaimAmounts(claim({ total_amount: 100, nhis_claim_services: [{ total_amount: 30 }] }))
    expect(result).toEqual({ services: 30, pharmacy: 70, investigations: 0, total: 100 })
  })

  it('falls back to the medicine lines when the claim has no total', () => {
    const result = splitClaimAmounts({ total_amount: null, nhis_claim_medicines: [{ total_amount: 10.1 }, { total_amount: 20.2 }] })
    expect(result.total).toBe(30.3)
    expect(result.pharmacy).toBe(30.3)
  })

  it('never lets the pharmacy amount go below zero', () => {
    expect(splitClaimAmounts(claim({ total_amount: 10, nhis_claim_services: [{ total_amount: 25 }] })).pharmacy).toBe(0)
  })

  it('removes floating point noise', () => {
    expect(splitClaimAmounts(claim({ total_amount: 0.1 + 0.2 })).total).toBe(0.3)
  })
})

describe('which claims are counted and in what order', () => {
  it('counts only served, submitted and paid claims', () => {
    for (const status of ['served', 'submitted', 'paid', 'SERVED']) expect(isReportClaim({ status })).toBe(true)
    for (const status of ['draft', 'pending_serving', 'serving_in_progress', 'returned_for_review', 'rejected', '', undefined]) {
      expect(isReportClaim({ status })).toBe(false)
    }
  })

  it('counts the claims left out', () => {
    expect(countClaimsLeftOut([claim(), claim({ id: 'c2', status: 'draft' }), claim({ id: 'c3', status: 'rejected' })])).toBe(2)
  })

  it('sorts by service date, then creation time, then claim number', () => {
    const sorted = sortClaimsForReport([
      claim({ id: 'c', service_date_from: '2026-04-02' }),
      claim({ id: 'b', created_at: '2026-04-01T10:00:00Z' }),
      claim({ id: 'a' }),
    ])
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('numbers counted claims 1..N and does not change the input', () => {
    const input = [claim({ id: 'b', service_date_from: '2026-04-02' }), claim({ id: 'draft', status: 'draft' }), claim({ id: 'a' })]
    const numbered = buildNumberedReportClaims(input)
    expect(numbered.map((row) => [row.number, row.claim.id])).toEqual([[1, 'a'], [2, 'b']])
    expect(input.map((item) => item.id)).toEqual(['b', 'draft', 'a'])
  })
})

describe('claim summary workbook', () => {
  const claims = [
    claim({ id: 'a', total_amount: 125.5 }),
    claim({ id: 'b', surname: 'DELTA', other_names: 'YAW', gender: 'Male', date_of_birth: '2013-05-16', total_amount: 300.25, service_date_from: '2026-04-02', service_date_to: '2026-04-02' }),
    claim({ id: 'draft', status: 'draft', total_amount: 999 }),
  ]

  it('has the CLAIM-it sheets and header row', () => {
    const { sheets } = buildClaimSummarySheets({ claims, facilityName: 'Sample Chemist', yearMonth: '2026-04' })
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['ALL CLAIMS', 'SUMMARY'])
    const rows = flat(sheets[0])
    expect(rows[0][0]).toBe('SAMPLE CHEMIST')
    expect(rows[1][0]).toBe('APR 2026')
    expect(rows[2]).toEqual([
      'No', 'SURNAME', 'OTHER NAMES', 'DOB', 'GENDER', 'ADMISSION', 'DISCHARGE', 'FOLDER NO.', 'MEMBER NO.', 'CCC',
      'PROCEDURES', 'ICD10', 'DIAGNOSES', 'GDRG', 'SERVICES (GHC)', 'PHARMACY (GHC)', 'INVESTIGATIONS (GHC)',
      'TOTAL (GHC)', 'SPECIALTY', 'AGE GROUP', 'TOS', 'SPECIALTY2',
    ])
    expect(sheets[0].stickyRowsCount).toBe(3)
  })

  it('every row has the same number of cells as the header', () => {
    const { sheets } = buildClaimSummarySheets({ claims, facilityName: 'Sample Chemist', yearMonth: '2026-04' })
    for (const sheet of sheets) {
      const widths = new Set(sheet.data.map((row) => row.length))
      expect(widths.size).toBe(1)
    }
    expect(sheets[0].columns).toHaveLength(22)
  })

  it('writes one row per counted claim with the CLAIM-it fixed values', () => {
    const { sheets, attendance } = buildClaimSummarySheets({ claims, facilityName: 'Sample Chemist', yearMonth: '2026-04' })
    expect(attendance).toBe(2)
    const rows = flat(sheets[0])
    const first = rows[3]
    expect(first[0]).toBe(1)
    expect(first.slice(1, 3)).toEqual(['ALPHA', 'ADWOA'])
    expect(first[4]).toBe('F')
    expect(first[7]).toBe('F-0001')
    expect(first[8]).toBe('10000001')
    expect(first[9]).toBe('10001')
    expect(first.slice(10, 14)).toEqual(['', '', '', ''])
    expect(first.slice(14, 18)).toEqual([0, 125.5, 0, 125.5])
    expect(first[18]).toBe('PHC')
    expect(first[19]).toBe('A')
    expect(first[20]).toBe('PHC')
    // the second claim is a 12-year-old on the service date
    expect(rows[4][19]).toBe('A')
    expect(first[3]).toBeInstanceOf(Date)
    expect(first[3].toISOString()).toBe('1970-01-15T00:00:00.000Z')
  })

  it('totals and the SUMMARY sheet agree with the rows', () => {
    const { sheets, totals } = buildClaimSummarySheets({ claims, facilityName: 'Sample Chemist', yearMonth: '2026-04' })
    expect(totals.pharmacy).toBe(425.75)
    const claimsRows = flat(sheets[0])
    const totalRow = claimsRows[claimsRows.length - 1]
    expect(totalRow[0]).toBe('TOTAL')
    expect(totalRow[1]).toBe('2 claims')
    expect(totalRow[15]).toBeCloseTo(425.75, 4)
    const summary = flat(sheets[1])
    expect(summary[0][0]).toBe('SAMPLE CHEMIST')
    expect(summary[1][0]).toBe('PHC')
    expect(summary[2]).toEqual(['MDC', 'ATTENDANCE', 'SERVICES', 'MEDICINES', 'TOTAL (GHC)'])
    expect(summary[3].slice(0, 3)).toEqual(['PHC', 2, 0])
    expect(summary[3][3]).toBeCloseTo(425.75, 4)
    expect(summary[4][0]).toBe('TOTAL')
    expect(summary[6][0]).toBe('GRAND TOTAL')
    expect(summary[6][1]).toBe(2)
  })

  it('uses a singular label for a single claim and copes with no claims', () => {
    const one = buildClaimSummarySheets({ claims: [claim()], facilityName: 'x', yearMonth: '2026-04' })
    expect(flat(one.sheets[0]).at(-1)[1]).toBe('1 claim')
    const none = buildClaimSummarySheets({ claims: [], facilityName: '', yearMonth: '2026-04' })
    expect(none.attendance).toBe(0)
    expect(flat(none.sheets[0])[0][0]).toBe('PHARMACY')
    expect(flat(none.sheets[1])[3].slice(0, 2)).toEqual(['PHC', 0])
  })

  it('writes a service end date equal to the start when the claim has none', () => {
    const { sheets } = buildClaimSummarySheets({ claims: [claim({ service_date_to: null })], facilityName: 'x', yearMonth: '2026-04' })
    const row = flat(sheets[0])[3]
    expect(row[5].toISOString()).toBe(row[6].toISOString())
  })
})

describe('pharmacy working sheet', () => {
  const claims = [
    claim({ id: 'a', total_amount: 100 }),
    claim({ id: 'b', surname: 'BETA', other_names: 'EFUA', total_amount: 50, service_date_from: '2026-04-02', service_date_to: '2026-04-02' }),
    claim({ id: 'c', surname: 'GAMMA', other_names: 'AMA', total_amount: 25, service_date_from: '2026-04-03', service_date_to: '2026-04-03' }),
    claim({ id: 'draft', status: 'draft', total_amount: 999 }),
  ]

  it('matches the pharmacy sample layout: headers on row 1, month banner on row 2', () => {
    const { sheets } = buildWorkingSheet({ claims, facilityName: 'Sample Chemist', yearMonth: '2026-04' })
    expect(sheets).toHaveLength(1)
    const rows = flat(sheets[0])
    expect(rows[0]).toEqual([
      'NO.', 'SURNAME', 'OTHER NAMES', 'DOB', 'GENDER', 'DATE OF SERVICE', 'DISCHARGE', 'FOLDER NUMBER',
      'MEMBERSHIP NUMBER', 'CCC', 'AMOUNT', 'ATTACHMENT NO',
    ])
    expect(rows[1][0]).toBeNull()
    expect(rows[1][1]).toBe('SAMPLE CHEMIST · APRIL 2026')
    expect(sheets[0].data.every((row) => row.length === 12)).toBe(true)
    expect(sheets[0].columns).toHaveLength(12)
  })

  it('keeps the original numbers and leaves a gap for each claim left out', () => {
    const { sheets, count } = buildWorkingSheet({ claims, facilityName: 'x', yearMonth: '2026-04', excludedIds: ['b'] })
    expect(count).toBe(2)
    const numbers = flat(sheets[0]).slice(2, -1).map((row) => row[0])
    expect(numbers).toEqual([1, 3])
  })

  it('never includes claims that are not counted, even if asked', () => {
    const { sheets, count } = buildWorkingSheet({ claims, facilityName: 'x', yearMonth: '2026-04' })
    expect(count).toBe(3)
    const surnames = flat(sheets[0]).slice(2, -1).map((row) => row[1])
    expect(surnames).toEqual(['ALPHA', 'BETA', 'GAMMA'])
  })

  it('writes the attachment number as text and keeps its leading zero', () => {
    const { sheets } = buildWorkingSheet({ claims, facilityName: 'x', yearMonth: '2026-04', attachmentNumbers: { a: '0380', b: ' 0390 ' } })
    const rows = flat(sheets[0]).slice(2, -1)
    expect(rows[0][11]).toBe('0380')
    expect(typeof rows[0][11]).toBe('string')
    expect(rows[1][11]).toBe('0390')
    expect(rows[2][11]).toBe('')
  })

  it('uses the pharmacy amount and totals only the claims included', () => {
    const { sheets, totalAmount } = buildWorkingSheet({ claims, facilityName: 'x', yearMonth: '2026-04', excludedIds: ['c'] })
    expect(totalAmount).toBe(150)
    const rows = flat(sheets[0])
    expect(rows.at(-1)[0]).toBe('TOTAL')
    expect(rows.at(-1)[1]).toBe('2 claims')
    expect(rows.at(-1)[10]).toBe(150)
  })

  it('handles every claim being left out', () => {
    const { sheets, count, totalAmount } = buildWorkingSheet({ claims, facilityName: 'x', yearMonth: '2026-04', excludedIds: ['a', 'b', 'c'] })
    expect(count).toBe(0)
    expect(totalAmount).toBe(0)
    expect(flat(sheets[0]).at(-1)[1]).toBe('0 claims')
  })

  it('trims attachment numbers to a sensible length', () => {
    expect(cleanAttachmentNumber('  0123  ')).toBe('0123')
    expect(cleanAttachmentNumber('x'.repeat(40))).toHaveLength(24)
    expect(cleanAttachmentNumber(null)).toBe('')
  })
})

describe('file names', () => {
  it('names each file after the pharmacy, the kind and the month', () => {
    expect(buildReportFileName('summary', 'Sample Chemist', '2026-04')).toBe('Sample Chemist claim summary APR 2026.xlsx')
    expect(buildReportFileName('working', 'Sample Chemist', '2026-04')).toBe('Sample Chemist working sheet APR 2026.xlsx')
  })

  it('removes characters Windows does not allow in file names', () => {
    expect(buildReportFileName('summary', 'A/B: "C"?', '2026-04')).toBe('A B C claim summary APR 2026.xlsx')
    expect(buildReportFileName('summary', '', '2026-04')).toBe('Pharmacy claim summary APR 2026.xlsx')
  })
})

describe('remembering selections in this browser', () => {
  const makeStorage = () => {
    const data = new Map()
    return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data }
  }

  it('saves and loads ticks and typed numbers per pharmacy and month', () => {
    const storage = makeStorage()
    expect(saveReportSelection(storage, 'org1', '2026-04', { excludedIds: ['b'], attachmentNumbers: { a: '0380', b: '' } })).toBe(true)
    expect(loadReportSelection(storage, 'org1', '2026-04')).toEqual({ excludedIds: ['b'], attachmentNumbers: { a: '0380' } })
    expect(loadReportSelection(storage, 'org1', '2026-05')).toEqual({ excludedIds: [], attachmentNumbers: {} })
    expect(loadReportSelection(storage, 'org2', '2026-04')).toEqual({ excludedIds: [], attachmentNumbers: {} })
  })

  it('survives broken or missing storage', () => {
    expect(loadReportSelection(null, 'o', '2026-04')).toEqual({ excludedIds: [], attachmentNumbers: {} })
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(loadReportSelection(broken, 'o', '2026-04')).toEqual({ excludedIds: [], attachmentNumbers: {} })
    expect(saveReportSelection(broken, 'o', '2026-04', { excludedIds: [], attachmentNumbers: {} })).toBe(false)
    const garbage = makeStorage()
    garbage.setItem('healthflow.nhisMonthlyReports.v1:o:2026-04', '{not json')
    expect(loadReportSelection(garbage, 'o', '2026-04')).toEqual({ excludedIds: [], attachmentNumbers: {} })
  })
})
