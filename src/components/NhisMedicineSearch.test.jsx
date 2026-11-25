import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeCalls = []
vi.mock('write-excel-file/browser', () => ({
  default: vi.fn((sheets) => {
    const call = { sheets, fileName: null }
    writeCalls.push(call)
    return { toFile: vi.fn(async (name) => { call.fileName = name }) }
  }),
}))
vi.mock('../services/nhisMedicineSearchService', () => ({ searchMedicineLines: vi.fn() }))
vi.mock('../services/auditService', () => ({ logAuditEvent: vi.fn() }))

import NhisMedicineSearch from './NhisMedicineSearch'

const claim = (id, surname, overrides = {}) => ({
  id,
  claim_number: `CL-${id}`,
  status: 'served',
  surname,
  other_names: 'AMA',
  member_no: `2000${id}`,
  folder_no: `F${id}`,
  ccc_no: `5000${id}`,
  gender: 'Female',
  date_of_birth: '1970-01-01',
  service_date_from: '2026-10-05',
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
  claim: claimRow,
  ...overrides,
})

const cashLine = (id, description, name, overrides = {}) => ({
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
    id: `sale-${id}`, claim_number: `SL-${id}`, status: 'completed', surname: name, other_names: '', member_no: '',
    folder_no: `P${id}`, ccc_no: '', gender: 'Male', date_of_birth: null, service_date_from: '2026-10-08',
  },
  ...overrides,
})

const LINES = [
  line(1, 'Tamoxifen Tablet 20mg', claim('1', 'ALPHA'), { dispensed_qty: 30, total_amount: 60 }),
  line(2, 'Capecitabine Tablet 500mg', claim('2', 'BETA'), { dispensed_qty: 10, total_amount: 150 }),
]

const renderScreen = (props = {}) => {
  const searchMedicines = vi.fn(async () => LINES)
  const recordAudit = vi.fn(async () => {})
  const notify = vi.fn()
  render(
    <NhisMedicineSearch
      organizationId="org1"
      facilityName="Sample Chemist"
      searchMedicines={searchMedicines}
      recordAudit={recordAudit}
      onClose={() => {}}
      notify={notify}
      {...props}
    />
  )
  return { searchMedicines, recordAudit, notify }
}

const typeList = (value) => fireEvent.change(screen.getByLabelText('Medicines to look for'), { target: { value } })
const search = () => fireEvent.click(screen.getByRole('button', { name: /Search/ }))

describe('medicine search screen', () => {
  it('looks in NHIS claims and cash sales unless told otherwise, and can be narrowed', async () => {
    const { searchMedicines } = renderScreen()
    expect(screen.getByLabelText('Look in')).toHaveValue('all')
    typeList('Tamoxifen')
    search()
    await screen.findByText(/ALPHA AMA/)
    expect(searchMedicines.mock.calls[0][0].source).toBe('all')

    fireEvent.change(screen.getByLabelText('Look in'), { target: { value: 'cash' } })
    search()
    await waitFor(() => expect(searchMedicines).toHaveBeenCalledTimes(2))
    expect(searchMedicines.mock.calls[1][0].source).toBe('cash')
  })

  it('lists cash-sale patients with how they were given the medicine, and says how many walk-in lines were left out', async () => {
    renderScreen({
      searchMedicines: vi.fn(async () => [
        ...LINES,
        cashLine(1, 'Anastrozole 1mg', 'Kwesi Mensah'),
        cashLine(2, 'Anastrozole 1mg', '', { hasPatient: false }),
      ]),
    })
    typeList('Tamoxifen, Anastrozole (Arimidex)')
    search()
    const row = (await screen.findByText(/Kwesi Mensah/)).closest('tr')
    expect(row).toHaveTextContent('Cash sale')
    expect(row).toHaveTextContent('Anastrozole (Arimidex) ×4')
    expect(screen.getByText(/ALPHA AMA/).closest('tr')).toHaveTextContent('NHIS claim')
    expect(screen.getByText(/1 cash sale line with no patient recorded was left out/)).toBeInTheDocument()
  })


  beforeEach(() => {
    writeCalls.length = 0
    window.localStorage.clear()
  })

  it('searches the typed names for this pharmacy and lists the patients', async () => {
    const { searchMedicines } = renderScreen()
    typeList('Tamoxifen, Xeloda (Capecitabine)')
    search()
    expect(await screen.findByText(/ALPHA AMA/)).toBeInTheDocument()
    expect(screen.getByText(/BETA AMA/)).toBeInTheDocument()
    const options = searchMedicines.mock.calls[0][0]
    expect(options.organizationId).toBe('org1')
    expect(options.terms).toEqual(['tamoxifen', 'xeloda', 'capecitabine'])
    expect(options.fromDate).toMatch(/^\d{4}-\d{2}-01$/)
    expect(options.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(screen.getByText('Tamoxifen ×30')).toBeInTheDocument()
    expect(screen.getByText('Xeloda (Capecitabine) ×10')).toBeInTheDocument()
    expect(screen.getByText(/served, submitted and paid claims/)).toBeInTheDocument()
  })

  it('shows a row for every medicine searched, including one nobody was given', async () => {
    renderScreen()
    typeList('Tamoxifen, Paclitaxel')
    search()
    await screen.findByText(/ALPHA AMA/)
    const summary = screen.getAllByRole('table')[0]
    const paclitaxel = within(summary).getByText('Paclitaxel').closest('tr')
    expect(paclitaxel).toHaveTextContent('0')
  })

  it('asks for a medicine name before searching', async () => {
    const { searchMedicines } = renderScreen()
    search()
    expect(await screen.findByRole('alert')).toHaveTextContent('Type at least one medicine name')
    expect(searchMedicines).not.toHaveBeenCalled()
  })

  it('warns about names that are too short', async () => {
    renderScreen()
    typeList('Tamoxifen, ab')
    search()
    await screen.findByText(/ALPHA AMA/)
    expect(screen.getByText(/Left out because the name is too short/)).toHaveTextContent('ab')
  })

  it('says so when nobody was given the medicines', async () => {
    renderScreen({ searchMedicines: vi.fn(async () => []) })
    typeList('Tamoxifen')
    search()
    expect(await screen.findByText(/No patient was given these medicines/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download Excel/ })).toBeDisabled()
  })

  it('shows the reason when the search fails and offers no download', async () => {
    renderScreen({ searchMedicines: vi.fn(async () => { throw new Error('Medicine search needs an internet connection.') }) })
    typeList('Tamoxifen')
    search()
    expect(await screen.findByRole('alert')).toHaveTextContent('needs an internet connection')
    expect(screen.getByRole('button', { name: /Download Excel/ })).toBeDisabled()
  })

  it('downloads a workbook of the results and records the export without patient details', async () => {
    const { recordAudit, notify } = renderScreen()
    typeList('Tamoxifen, Xeloda (Capecitabine)')
    search()
    await screen.findByText(/ALPHA AMA/)
    fireEvent.click(screen.getByRole('button', { name: /Download Excel/ }))
    await waitFor(() => expect(writeCalls).toHaveLength(1))
    expect(writeCalls[0].sheets.map((sheet) => sheet.sheet)).toEqual(['SUMMARY', 'PATIENTS', 'DETAILS'])
    await waitFor(() => expect(writeCalls[0].fileName).toMatch(/^Sample Chemist medicine search .+\.xlsx$/))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Medicine search downloaded.', 'success'))
    await waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1))
    const audit = recordAudit.mock.calls[0][0]
    expect(audit).toMatchObject({ eventType: 'nhis_medicine_search_export', action: 'export' })
    expect(audit.details).toMatchObject({ medicines_searched: 2, patients: 2, source: 'all' })
    expect(JSON.stringify(audit)).not.toMatch(/ALPHA|BETA|2000|Tamoxifen|Capecitabine/)
  })

  it('still reports success when the audit line cannot be written', async () => {
    const { notify } = renderScreen({ recordAudit: vi.fn(async () => { throw new Error('audit down') }) })
    typeList('Tamoxifen')
    search()
    await screen.findByText(/ALPHA AMA/)
    fireEvent.click(screen.getByRole('button', { name: /Download Excel/ }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Medicine search downloaded.', 'success'))
    expect(notify).not.toHaveBeenCalledWith(expect.anything(), 'error')
  })

  it('reports a failed download instead of failing silently', async () => {
    const writer = (await import('write-excel-file/browser')).default
    writer.mockImplementationOnce(() => ({ toFile: vi.fn(async () => { throw new Error('Disk is full') }) }))
    const { notify } = renderScreen()
    typeList('Tamoxifen')
    search()
    await screen.findByText(/ALPHA AMA/)
    fireEvent.click(screen.getByRole('button', { name: /Download Excel/ }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Disk is full', 'error'))
  })

  it('remembers the typed list for this pharmacy', async () => {
    const first = render(
      <NhisMedicineSearch organizationId="org1" facilityName="W" searchMedicines={async () => LINES} onClose={() => {}} />
    )
    typeList('Tamoxifen, Xeloda (Capecitabine)')
    search()
    await screen.findByText(/ALPHA AMA/)
    first.unmount()

    render(<NhisMedicineSearch organizationId="org1" facilityName="W" searchMedicines={async () => LINES} onClose={() => {}} />)
    expect(screen.getByLabelText('Medicines to look for')).toHaveValue('Tamoxifen, Xeloda (Capecitabine)')

    render(<NhisMedicineSearch organizationId="other" facilityName="W" searchMedicines={async () => LINES} onClose={() => {}} />)
    expect(screen.getAllByLabelText('Medicines to look for')[1]).toHaveValue('')
  })

  it('offers the last 24 months for both ends of the period', async () => {
    renderScreen()
    expect(within(screen.getByLabelText('From')).getAllByRole('option')).toHaveLength(24)
    expect(within(screen.getByLabelText('To')).getAllByRole('option')).toHaveLength(24)
  })

  it('replaces the earlier results when it is searched again', async () => {
    let releaseFirst
    const searchMedicines = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve([line(9, 'Tamoxifen 20mg', claim('9', 'OLDONE'))]) }))
      .mockImplementationOnce(async () => [line(8, 'Tamoxifen 20mg', claim('8', 'NEWONE'))])
    render(<NhisMedicineSearch organizationId="org1" facilityName="W" searchMedicines={searchMedicines} onClose={() => {}} />)
    typeList('Tamoxifen')
    search()
    releaseFirst()
    await screen.findByText(/OLDONE AMA/)
    search()
    expect(await screen.findByText(/NEWONE AMA/)).toBeInTheDocument()
    expect(screen.queryByText(/OLDONE AMA/)).not.toBeInTheDocument()
  })

  it('pages through a long list of patients 50 at a time', async () => {
    const lines = Array.from({ length: 120 }, (_, index) => {
      const id = String(index + 1)
      return line(id, 'Tamoxifen 20mg', claim(id, `NAME${id.padStart(3, '0')}`))
    })
    renderScreen({ searchMedicines: vi.fn(async () => lines) })
    typeList('Tamoxifen')
    search()
    await screen.findByText(/NAME001 AMA/)
    expect(screen.getByText('1-50 of 120')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('51-100 of 120')).toBeInTheDocument()
    expect(screen.getByText(/NAME051 AMA/)).toBeInTheDocument()
  })
})
