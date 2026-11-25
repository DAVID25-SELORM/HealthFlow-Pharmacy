import { describe, expect, it } from 'vitest'
import {
  allSearchTerms,
  buildMedicineSearchFileName,
  buildMedicineSearchResult,
  buildMedicineSearchSheets,
  describePatientMedicines,
  describeSources,
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
    expect(describePatientMedicines(addo)).toBe('Xeloda (Capecitabine) ×20: 10/09/2026\nTamoxifen ×60: 10/09/2026, 12/10/2026')

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

describe('every date a medicine was given', () => {
  const { groups } = parseMedicineSearch('Tamoxifen')
  const given = (id, date, extra = {}) => line(id, 'Tamoxifen 20mg', claim(String(id), { service_date_from: date }), extra)

  it('lists all dates oldest first, whatever order the records arrive in', () => {
    const result = buildMedicineSearchResult({
      groups, lines: [given(1, '2026-11-02'), given(2, '2026-09-05'), given(3, '2026-10-03')],
    })
    expect(result.patients[0].medicines[0].dates).toEqual(['2026-09-05', '2026-10-03', '2026-11-02'])
    expect(describePatientMedicines(result.patients[0])).toBe('Tamoxifen ×6: 05/09/2026, 03/10/2026, 02/11/2026')
  })

  it('lists a day once even with two records on it, while still adding both quantities', () => {
    const result = buildMedicineSearchResult({ groups, lines: [given(1, '2026-09-05'), given(2, '2026-09-05')] })
    expect(describePatientMedicines(result.patients[0])).toBe('Tamoxifen ×4: 05/09/2026')
  })

  it('uses the dispensing date when the claim line has one', () => {
    const result = buildMedicineSearchResult({
      groups, lines: [given(1, '2026-09-05', { dispensary_date: '2026-09-09' })],
    })
    expect(result.patients[0].medicines[0].dates).toEqual(['2026-09-09'])
  })

  it('leaves the dates off when a record has none', () => {
    const result = buildMedicineSearchResult({ groups, lines: [given(1, null)] })
    expect(describePatientMedicines(result.patients[0])).toBe('Tamoxifen ×2')
  })

  it('keeps every date over two years and makes the Excel row taller to show them', () => {
    const lines = Array.from({ length: 24 }, (_, index) => {
      const month = String((index % 12) + 1).padStart(2, '0')
      return given(index + 1, `${index < 12 ? 2025 : 2026}-${month}-15`)
    })
    const result = buildMedicineSearchResult({ groups, lines })
    expect(result.patients[0].medicines[0].dates).toHaveLength(24)
    const sheets = buildMedicineSearchSheets({ result, groups, facilityName: 'Sample Chemist', fromMonth: '2025-01', toMonth: '2026-12' })
    const cell = sheets[1].data[2][7]
    expect(cell.value.match(/\/20(25|26)/g)).toHaveLength(24)
    expect(cell.wrap).toBe(true)
    expect(cell.height).toBeGreaterThanOrEqual(75)
    expect(cell.height).toBeLessThanOrEqual(405)
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
    expect(rows[0][7].value).toBe('Tamoxifen ×30: 10/09/2026')
    expect(sheets[1].data.at(-1)[1].value).toBe('2 patients')
  })

  it('lists one detail row per claim line with the medicine as written on the claim', () => {
    const rows = sheets[2].data.slice(2)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row[8].value)).toEqual(['NHIS claim', 'NHIS claim'])
    expect(rows.map((row) => row[9].value)).toEqual(['Tamoxifen 20mg', 'Capecitabine 500mg'])
    expect(rows.map((row) => row[10].value)).toEqual(['Tamoxifen', 'Xeloda (Capecitabine)'])
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

describe('cash sales alongside claims', () => {
  const { groups } = parseMedicineSearch('Tamoxifen, Anastrozole (Arimidex)')

  const sale = (id, description, overrides = {}) => ({
    id: `S${id}`,
    claim_id: `sale-${id}`,
    source: 'cash',
    hasPatient: true,
    description,
    unit_price: 5,
    dispensed_qty: 4,
    served_qty: 0,
    total_amount: 20,
    dispensary_date: '2026-10-08',
    claim: {
      id: `sale-${id}`, claim_number: `SL-${id}`, status: 'completed', surname: 'Kwesi Mensah', other_names: '',
      member_no: '', folder_no: 'P-7', patient_id: 'pat-7', ccc_no: '', gender: 'Male', date_of_birth: null,
      service_date_from: '2026-10-08',
    },
    ...overrides,
  })

  it('counts a completed cash sale for a registered patient', () => {
    const result = buildMedicineSearchResult({ groups, lines: [sale(1, 'Anastrozole 1mg tablet')] })
    expect(result.totals).toEqual({ patients: 1, claims: 1, amount: 20 })
    expect(result.patients[0].sources).toEqual(['cash'])
    expect(describeSources(result.patients[0].sources)).toBe('Cash sale')
    expect(result.details[0].source).toBe('cash')
  })

  it('leaves out sales with no patient and counts them', () => {
    const result = buildMedicineSearchResult({
      groups,
      lines: [sale(1, 'Anastrozole 1mg', { hasPatient: false }), sale(2, 'Anastrozole 1mg', { hasPatient: false }), sale(3, 'Paracetamol', { hasPatient: false })],
    })
    expect(result.totals.patients).toBe(0)
    expect(result.walkInLines).toBe(2)
  })

  it('does not count a cash sale line nothing was sold on', () => {
    const result = buildMedicineSearchResult({ groups, lines: [sale(1, 'Tamoxifen 20mg', { dispensed_qty: 0 })] })
    expect(result.totals.patients).toBe(0)
  })

  it('counts one person once when they got the medicine by claim and by cash, matched on member number', () => {
    const viaClaim = line(1, 'Tamoxifen 20mg', claim('1', { surname: 'ADDO', member_no: '1000001' }), { source: 'nhis' })
    const viaCash = sale(2, 'Tamoxifen 20mg', {
      claim: { ...sale(2, '').claim, surname: 'Ama Addo', member_no: '1000 001', folder_no: 'P-1', service_date_from: '2026-11-20' },
      dispensary_date: '2026-11-20',
    })
    const result = buildMedicineSearchResult({ groups, lines: [viaClaim, viaCash] })
    expect(result.totals.patients).toBe(1)
    expect(result.totals.claims).toBe(2)
    expect(result.patients[0].sources).toEqual(['nhis', 'cash'])
    expect(describeSources(result.patients[0].sources)).toBe('NHIS claim + Cash sale')
    expect(result.patients[0].lastDate).toBe('2026-11-20')
    // the claim's spelling of the name wins over the registered name on the sale
    expect(result.patients[0].surname).toBe('ADDO')
  })

  it('keeps a claim and a sale with the same number apart when they are different records', () => {
    const viaClaim = line(1, 'Tamoxifen 20mg', claim('7', { member_no: '1000007' }), { source: 'nhis' })
    const viaCash = sale(7, 'Tamoxifen 20mg')
    expect(buildMedicineSearchResult({ groups, lines: [viaClaim, viaCash] }).totals.claims).toBe(2)
  })

  it('shows the source in the workbook and notes left-out sales', () => {
    const result = buildMedicineSearchResult({
      groups,
      lines: [sale(1, 'Anastrozole 1mg'), sale(2, 'Anastrozole 1mg', { hasPatient: false })],
    })
    const sheets = buildMedicineSearchSheets({ result, groups, facilityName: 'Sample Chemist', fromMonth: '2026-10', toMonth: '2026-10', source: 'cash' })
    expect(sheets[0].data[0][0].value).toContain('CASH SALES ONLY')
    expect(sheets[0].data.at(-1)[0].value).toBe('1 cash sale line with no patient recorded was left out.')
    expect(sheets[1].data[1].map((cell) => cell.value)).toContain('GIVEN VIA')
    expect(sheets[1].data[2][8].value).toBe('Cash sale')
    expect(sheets[2].data[1].map((cell) => cell.value)).toContain('SOURCE')
    expect(sheets[2].data[2][8].value).toBe('Cash sale')
  })
})
