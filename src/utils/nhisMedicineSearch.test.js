import { describe, expect, it } from 'vitest'
import {
  allSearchTerms,
  buildMedicineSearchFileName,
  buildMedicineSearchResult,
  buildMedicineSearchSheets,
  describePatientMedicines,
  formatSearchPeriod,
  getGivenQuantity,
  loadSavedMedicineList,
  monthRangeToDates,
  parseMedicineSearch,
  saveMedicineList,
} from './nhisMedicineSearch'

const LIST = 'Paclitaxel, Docetaxel, Xeloda (Capecitabine), Anastrozole (Arimidex), Tamoxifen'

const claim = (id, overrides = {}) => ({
  id,
  claim_number: `CL-${id}`,
  status: 'served',
  surname: 'ADDO',
  other_names: 'AMA',
  member_no: '1000001',
  folder_no: 'F-1',
  ccc_no: '4000001',
  gender: 'Female',
  date_of_birth: '1970-05-05',
  service_date_from: '2026-09-10',
  ...overrides,
})

const line = (id, description, claimRow, overrides = {}) => ({
  id: `L${id}`,
  claim_id: claimRow.id,
  description,
  unit_price: 10,
  dispensed_qty: 2,
  served_qty: 0,
  total_amount: 20,
  dispensary_date: null,
  claim: claimRow,
  ...overrides,
})

describe('reading the typed medicine list', () => {
  it('reads a pasted list with brand and generic names', () => {
    const { groups, ignored } = parseMedicineSearch(LIST)
    expect(ignored).toEqual([])
    expect(groups.map((group) => group.label)).toEqual([
      'Paclitaxel', 'Docetaxel', 'Xeloda (Capecitabine)', 'Anastrozole (Arimidex)', 'Tamoxifen',
    ])
    expect(groups[2].terms).toEqual(['xeloda', 'capecitabine'])
    expect(groups[3].terms).toEqual(['anastrozole', 'arimidex'])
    expect(allSearchTerms(groups)).toEqual([
      'paclitaxel', 'docetaxel', 'xeloda', 'capecitabine', 'anastrozole', 'arimidex', 'tamoxifen',
    ])
  })

  it('accepts new lines, slashes and a repeated entry', () => {
    const { groups } = parseMedicineSearch('Tamoxifen\nxeloda / capecitabine\n\nTamoxifen')
    expect(groups.map((group) => group.label)).toEqual(['Tamoxifen', 'xeloda / capecitabine'])
    expect(groups[1].terms).toEqual(['xeloda', 'capecitabine'])
  })

  it('does not split on a comma inside brackets', () => {
    const { groups } = parseMedicineSearch('Anastrozole (Arimidex, Anabrez), Letrozole')
    expect(groups).toHaveLength(2)
    expect(groups[0].terms).toEqual(['anastrozole', 'arimidex', 'anabrez'])
  })

  it('leaves out names that are too short and reports them', () => {
    const { groups, ignored } = parseMedicineSearch('Tamoxifen, ab, X')
    expect(groups.map((group) => group.label)).toEqual(['Tamoxifen'])
    expect(ignored).toEqual(['ab', 'X'])
  })

  it('strips characters that could break the cloud filter', () => {
    const { groups } = parseMedicineSearch('Tamo*xifen%"')
    expect(groups[0].terms).toEqual(['tamo xifen'])
  })

  it('caps the list at 20 medicines and says so', () => {
    const many = Array.from({ length: 25 }, (_, index) => `Medicine${index}`).join(', ')
    const parsed = parseMedicineSearch(many)
    expect(parsed.groups).toHaveLength(20)
    expect(parsed.tooMany).toBe(true)
  })

  it('returns nothing for an empty box', () => {
    expect(parseMedicineSearch('  ,  \n ').groups).toEqual([])
  })
})

describe('months', () => {
  it('turns two months into the first and last day, whichever order they are given', () => {
    expect(monthRangeToDates('2026-09', '2026-11')).toEqual({
      fromMonth: '2026-09', toMonth: '2026-11', fromDate: '2026-09-01', toDate: '2026-11-30',
    })
    expect(monthRangeToDates('2026-11', '2026-09').fromDate).toBe('2026-09-01')
    expect(monthRangeToDates('2028-02', '2028-02').toDate).toBe('2028-02-29')
    expect(monthRangeToDates('', '2026-09')).toBeNull()
    expect(monthRangeToDates('2026-13', '2026-09')).toBeNull()
  })

  it('describes the period for headings and file names', () => {
    expect(formatSearchPeriod('2026-09', '2026-11')).toBe('SEPTEMBER 2026 to NOVEMBER 2026')
    expect(formatSearchPeriod('2026-09', '2026-09', { short: true })).toBe('SEP 2026')
    expect(buildMedicineSearchFileName('Sample/Chemist: Ltd', '2026-09', '2026-11'))
      .toBe('Sample Chemist Ltd medicine search SEP 2026 to NOV 2026.xlsx')
  })
})

describe('building the patient summary', () => {
  const { groups } = parseMedicineSearch(LIST)

  it('counts what was given, once per patient, and matches brand or generic names', () => {
    const a1 = claim('1')
    const a2 = claim('2', { service_date_from: '2026-10-12' })
    const b1 = claim('3', { surname: 'BOATENG', other_names: 'KOFI', member_no: '1000002', service_date_from: '2026-09-20' })
    const result = buildMedicineSearchResult({
      groups,
      lines: [
        line(1, 'Tamoxifen Tablet 20mg', a1, { dispensed_qty: 30, total_amount: 60 }),
        line(2, 'Tamoxifen Tablet 20mg', a2, { dispensed_qty: 30, total_amount: 60 }),
        line(3, 'CAPECITABINE TABLET 500MG', a1, { dispensed_qty: 20, total_amount: 200 }),
        line(4, 'Xeloda 500mg', b1, { dispensed_qty: 10, total_amount: 150 }),
        line(5, 'Paracetamol 500mg', b1),
      ],
    })

    expect(result.totals).toEqual({ patients: 2, claims: 3, amount: 470 })
    expect(result.patients.map((patient) => patient.surname)).toEqual(['ADDO', 'BOATENG'])

    const addo = result.patients[0]
    expect(addo.claimCount).toBe(2)
    expect(addo.firstDate).toBe('2026-09-10')
    expect(addo.lastDate).toBe('2026-10-12')
    expect(addo.amount).toBe(320)
    expect(describePatientMedicines(addo)).toBe('Xeloda (Capecitabine) ×20; Tamoxifen ×60')

    const byLabel = Object.fromEntries(result.summary.map((entry) => [entry.label, entry]))
    expect(byLabel.Tamoxifen).toEqual({ label: 'Tamoxifen', patients: 1, claims: 2, quantity: 60, amount: 120 })
    expect(byLabel['Xeloda (Capecitabine)']).toMatchObject({ patients: 2, claims: 2, quantity: 30, amount: 350 })
    expect(byLabel.Paclitaxel).toEqual({ label: 'Paclitaxel', patients: 0, claims: 0, quantity: 0, amount: 0 })
    expect(result.details).toHaveLength(4)
  })

  it('ignores claims that are not served, submitted or paid, and lines nothing was given for', () => {
    const result = buildMedicineSearchResult({
      groups,
      lines: [
        line(1, 'Tamoxifen 20mg', claim('1', { status: 'draft' })),
        line(2, 'Tamoxifen 20mg', claim('2', { status: 'rejected' })),
        line(3, 'Tamoxifen 20mg', claim('3', { status: 'pending_serving' })),
        line(4, 'Tamoxifen 20mg', claim('4'), { dispensed_qty: 0, served_qty: 0 }),
        line(5, 'Tamoxifen 20mg', claim('5', { status: 'paid', member_no: '1000009' })),
        line(6, 'Tamoxifen 20mg', claim('6', { status: 'submitted', member_no: '1000010' })),
      ],
    })
    expect(result.totals.patients).toBe(2)
    expect(result.details).toHaveLength(2)
  })

  it('uses the served quantity when there is one, and falls back to dispensed', () => {
    expect(getGivenQuantity({ served_qty: 5, dispensed_qty: 9 })).toBe(5)
    expect(getGivenQuantity({ served_qty: 0, dispensed_qty: 9 })).toBe(9)
    expect(getGivenQuantity({})).toBe(0)
  })

  it('works out the amount from quantity and price when a line has no total', () => {
    const result = buildMedicineSearchResult({
      groups,
      lines: [line(1, 'Tamoxifen 20mg', claim('1'), { total_amount: null, dispensed_qty: 3, unit_price: 4.1 })],
    })
    expect(result.totals.amount).toBe(12.3)
  })

  it('treats one member number as one patient even when the name is typed differently', () => {
    const result = buildMedicineSearchResult({
      groups,
      lines: [
        line(1, 'Tamoxifen 20mg', claim('1', { member_no: '1000 003', other_names: 'AMA' })),
        line(2, 'Tamoxifen 20mg', claim('2', { member_no: '1000003', other_names: 'AMA B', service_date_from: '2026-11-01' })),
      ],
    })
    expect(result.totals.patients).toBe(1)
    expect(result.patients[0].otherNames).toBe('AMA B')
  })

  it('falls back to folder number, then name and date of birth, when there is no member number', () => {
    const result = buildMedicineSearchResult({
      groups,
      lines: [
        line(1, 'Tamoxifen 20mg', claim('1', { member_no: '', folder_no: 'F-9' })),
        line(2, 'Tamoxifen 20mg', claim('2', { member_no: '', folder_no: 'f-9' })),
        line(3, 'Tamoxifen 20mg', claim('3', { member_no: '', folder_no: '', surname: 'QUAYE' })),
        line(4, 'Tamoxifen 20mg', claim('4', { member_no: '', folder_no: '', surname: 'QUAYE' })),
      ],
    })
    expect(result.totals.patients).toBe(2)
  })

  it('counts one line under both entries when two entries name the same medicine', () => {
    const both = parseMedicineSearch('Tamoxifen, Tamoxifen 20mg').groups
    const result = buildMedicineSearchResult({ groups: both, lines: [line(1, 'Tamoxifen 20mg tablet', claim('1'))] })
    expect(result.summary.map((entry) => entry.patients)).toEqual([1, 1])
    expect(result.totals.amount).toBe(20)
    expect(result.details[0].searchedAs).toBe('Tamoxifen / Tamoxifen 20mg')
  })

  it('returns an empty result for no lines', () => {
    const result = buildMedicineSearchResult({ groups, lines: [] })
    expect(result.totals).toEqual({ patients: 0, claims: 0, amount: 0 })
    expect(result.summary).toHaveLength(5)
  })
})

describe('the Excel workbook', () => {
  const { groups } = parseMedicineSearch('Tamoxifen, Xeloda (Capecitabine)')
  const result = buildMedicineSearchResult({
    groups,
    lines: [
      line(1, 'Tamoxifen 20mg', claim('1'), { dispensed_qty: 30, total_amount: 60 }),
      line(2, 'Capecitabine 500mg', claim('2', { surname: 'BOATENG', member_no: '1000002' }), { dispensed_qty: 10, total_amount: 150 }),
    ],
  })
  const sheets = buildMedicineSearchSheets({ result, groups, facilityName: 'Sample Chemist', fromMonth: '2026-09', toMonth: '2026-11' })

  it('has a summary, a patients sheet and a details sheet', () => {
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['SUMMARY', 'PATIENTS', 'DETAILS'])
    sheets.forEach((sheet) => {
      expect(sheet.stickyRowsCount).toBe(2)
      expect(sheet.orientation).toBe('landscape')
    })
    expect(sheets[0].data[0][0].value).toBe('SAMPLE CHEMIST · PATIENTS GIVEN SELECTED MEDICINES · SEPTEMBER 2026 to NOVEMBER 2026')
  })

  it('lists one summary row per medicine and a total that counts each patient once', () => {
    const rows = sheets[0].data
    expect(rows.slice(2, -1).map((row) => [row[0].value, row[1].value, row[3].value, row[4].value])).toEqual([
      ['Tamoxifen', 1, 30, 60],
      ['Xeloda (Capecitabine)', 1, 10, 150],
    ])
    const total = rows.at(-1)
    expect(total[1].value).toBe(2)
    expect(total[4].value).toBe(210)
  })

  it('lists one row per patient with what they were given', () => {
    const rows = sheets[1].data.slice(2, -1)
    expect(rows).toHaveLength(2)
    expect(rows[0].map((cell) => cell.value).slice(1, 3)).toEqual(['ADDO', 'AMA'])
    expect(rows[0][5].value).toBe('1000001')
    expect(rows[0][7].value).toBe('Tamoxifen ×30')
    expect(sheets[1].data.at(-1)[1].value).toBe('2 patients')
  })

  it('lists one detail row per claim line with the medicine as written on the claim', () => {
    const rows = sheets[2].data.slice(2)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row[8].value)).toEqual(['Tamoxifen 20mg', 'Capecitabine 500mg'])
    expect(rows.map((row) => row[9].value)).toEqual(['Tamoxifen', 'Xeloda (Capecitabine)'])
    expect(rows[0][1].type).toBe(Date)
  })

  it('still produces a workbook when nothing was found', () => {
    const empty = buildMedicineSearchSheets({
      result: buildMedicineSearchResult({ groups, lines: [] }), groups, facilityName: 'Sample Chemist', fromMonth: '2026-09', toMonth: '2026-09',
    })
    expect(empty).toHaveLength(3)
    expect(empty[1].data.at(-1)[1].value).toBe('0 patients')
  })
})

describe('remembering the typed list', () => {
  const memory = () => {
    const store = {}
    return { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value } }
  }

  it('saves and loads per pharmacy', () => {
    const storage = memory()
    expect(saveMedicineList(storage, 'org1', LIST)).toBe(true)
    expect(loadSavedMedicineList(storage, 'org1')).toBe(LIST)
    expect(loadSavedMedicineList(storage, 'org2')).toBe('')
  })

  it('survives broken storage', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(saveMedicineList(broken, 'org1', LIST)).toBe(false)
    expect(loadSavedMedicineList(broken, 'org1')).toBe('')
    expect(loadSavedMedicineList(null, 'org1')).toBe('')
  })
})
