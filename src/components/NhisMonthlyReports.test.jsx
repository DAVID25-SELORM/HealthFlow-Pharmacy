import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeCalls = []
vi.mock('write-excel-file/browser', () => ({
  default: vi.fn((sheets, options) => {
    const call = { sheets, options, fileName: null }
    writeCalls.push(call)
    return { toFile: vi.fn(async (name) => { call.fileName = name }) }
  }),
}))
vi.mock('../services/nhisService', () => ({ getNhisClaimsForPeriod: vi.fn() }))

import NhisMonthlyReports from './NhisMonthlyReports'

const claim = (id, surname, overrides = {}) => ({
  id,
  claim_number: `CL-${id}`,
  status: 'served',
  surname,
  other_names: 'KOFI',
  gender: 'Male',
  date_of_birth: '1980-01-01',
  service_date_from: '2026-04-01',
  service_date_to: '2026-04-01',
  created_at: `2026-04-01T09:0${id}:00Z`,
  folder_no: `F${id}`,
  member_no: `1000${id}`,
  ccc_no: `4000${id}`,
  total_amount: 100,
  ...overrides,
})

const renderScreen = (rows, props = {}) => {
  const loadClaims = vi.fn(async () => rows)
  const notify = vi.fn()
  render(
    <NhisMonthlyReports
      organizationId="org1"
      facilityName="Sample Chemist"
      initialMonth="2026-04"
      loadClaims={loadClaims}
      onClose={() => {}}
      notify={notify}
      {...props}
    />
  )
  return { loadClaims, notify }
}

const rowFor = (name) => screen.getByText(name, { exact: false }).closest('tr')

describe('monthly claim reports screen', () => {
  beforeEach(() => {
    writeCalls.length = 0
    window.localStorage.clear()
  })

  it('loads the chosen month for this pharmacy and lists the counted claims in order', async () => {
    const { loadClaims } = renderScreen([claim('2', 'BETA', { service_date_from: '2026-04-02' }), claim('1', 'ALPHA'), claim('3', 'DRAFTY', { status: 'draft' })])
    expect(await screen.findByText(/ALPHA KOFI/)).toBeInTheDocument()
    expect(loadClaims).toHaveBeenCalledWith({ mode: 'month', yearMonth: '2026-04', organizationId: 'org1' })
    const names = screen.getAllByRole('row').slice(1).map((row) => row.textContent)
    expect(names[0]).toContain('ALPHA')
    expect(names[1]).toContain('BETA')
    expect(screen.queryByText(/DRAFTY/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 other claim this month is not served or submitted yet')
  })

  it('downloads the claim summary with every counted claim', async () => {
    const { notify } = renderScreen([claim('1', 'ALPHA'), claim('2', 'BETA')])
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.click(screen.getByRole('button', { name: /Download claim summary/ }))
    await waitFor(() => expect(writeCalls).toHaveLength(1))
    expect(writeCalls[0].sheets.map((sheet) => sheet.sheet)).toEqual(['ALL CLAIMS', 'SUMMARY'])
    await waitFor(() => expect(writeCalls[0].fileName).toBe('Sample Chemist claim summary APR 2026.xlsx'))
    expect(notify).toHaveBeenCalledWith('Claim summary downloaded.', 'success')
  })

  it('leaves out unticked claims from the working sheet but keeps the summary numbers', async () => {
    renderScreen([claim('1', 'ALPHA'), claim('2', 'BETA'), claim('3', 'GAMMA')])
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.click(within(rowFor('BETA')).getByRole('checkbox'))
    expect(screen.getByText(/ticked for the working sheet/).textContent).toContain('2')
    fireEvent.click(screen.getByRole('button', { name: /Download working sheet \(2\)/ }))
    await waitFor(() => expect(writeCalls).toHaveLength(1))
    const rows = writeCalls[0].sheets[0].data
    const numbers = rows.slice(2, -1).map((row) => row[0].value)
    expect(numbers).toEqual([1, 3])
    await waitFor(() => expect(writeCalls[0].fileName).toBe('Sample Chemist working sheet APR 2026.xlsx'))
  })

  it('puts typed attachment numbers in the working sheet as text with their leading zero', async () => {
    renderScreen([claim('1', 'ALPHA')])
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.change(screen.getByLabelText(/Attachment number for ALPHA KOFI/), { target: { value: '0380' } })
    fireEvent.click(screen.getByRole('button', { name: /Download working sheet/ }))
    await waitFor(() => expect(writeCalls).toHaveLength(1))
    const attachmentCell = writeCalls[0].sheets[0].data[2][11]
    expect(attachmentCell.value).toBe('0380')
  })

  it('remembers ticks and numbers for the month when the screen is opened again', async () => {
    const rows = [claim('1', 'ALPHA'), claim('2', 'BETA')]
    const first = render(
      <NhisMonthlyReports organizationId="org1" facilityName="W" initialMonth="2026-04" loadClaims={async () => rows} onClose={() => {}} />
    )
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.click(within(rowFor('BETA')).getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText(/Attachment number for ALPHA KOFI/), { target: { value: '0381' } })
    first.unmount()

    render(<NhisMonthlyReports organizationId="org1" facilityName="W" initialMonth="2026-04" loadClaims={async () => rows} onClose={() => {}} />)
    await screen.findByText(/ALPHA KOFI/)
    expect(within(rowFor('BETA')).getByRole('checkbox')).not.toBeChecked()
    expect(within(rowFor('ALPHA')).getByRole('checkbox')).toBeChecked()
    expect(screen.getByLabelText(/Attachment number for ALPHA KOFI/)).toHaveValue('0381')
  })

  it('does not mix up choices between pharmacies', async () => {
    window.localStorage.setItem('healthflow.nhisMonthlyReports.v1:other:2026-04', JSON.stringify({ excludedIds: ['1'], attachmentNumbers: { 1: '9999' } }))
    renderScreen([claim('1', 'ALPHA')])
    await screen.findByText(/ALPHA KOFI/)
    expect(within(rowFor('ALPHA')).getByRole('checkbox')).toBeChecked()
    expect(screen.getByLabelText(/Attachment number for ALPHA KOFI/)).toHaveValue('')
  })

  it('finds a claim by search and says when nothing matches', async () => {
    renderScreen([claim('1', 'ALPHA'), claim('2', 'BETA')])
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.change(screen.getByPlaceholderText(/Name, member number/), { target: { value: 'beta' } })
    expect(screen.queryByText(/ALPHA KOFI/)).not.toBeInTheDocument()
    expect(screen.getByText(/BETA KOFI/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/Name, member number/), { target: { value: 'zzz' } })
    expect(screen.getByText('No claim matches that search.')).toBeInTheDocument()
  })

  it('unticks and ticks all claims, and disables the working sheet when none are ticked', async () => {
    renderScreen([claim('1', 'ALPHA'), claim('2', 'BETA')])
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.click(screen.getByRole('button', { name: 'Untick all' }))
    expect(screen.getByRole('button', { name: /Download working sheet \(0\)/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Download claim summary/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Tick all' }))
    expect(screen.getByRole('button', { name: /Download working sheet \(2\)/ })).toBeEnabled()
  })

  it('shows the reason when the claims cannot be loaded and offers no download', async () => {
    renderScreen([], { loadClaims: vi.fn(async () => { throw new Error('Offline right now') }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline right now')
    expect(screen.getByRole('button', { name: /Download claim summary/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Download working sheet/ })).toBeDisabled()
  })

  it('says so when the month has no counted claims', async () => {
    renderScreen([claim('1', 'DRAFTY', { status: 'draft' })])
    expect(await screen.findByText(/No served, submitted or paid claims for APRIL 2026/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download claim summary/ })).toBeDisabled()
  })

  it('reports a failed download instead of failing silently', async () => {
    const writer = (await import('write-excel-file/browser')).default
    writer.mockImplementationOnce(() => ({ toFile: vi.fn(async () => { throw new Error('Disk is full') }) }))
    const { notify } = renderScreen([claim('1', 'ALPHA')])
    await screen.findByText(/ALPHA KOFI/)
    fireEvent.click(screen.getByRole('button', { name: /Download claim summary/ }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Disk is full', 'error'))
  })

  it('ignores a slow load for a month the user has already moved away from', async () => {
    let releaseFirst
    const loadClaims = vi.fn((options) => options.yearMonth === '2026-04'
      ? new Promise((resolve) => { releaseFirst = () => resolve([claim('1', 'OLDMONTH')]) })
      : Promise.resolve([claim('2', 'NEWMONTH')]))
    renderScreen([], { loadClaims })
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-05' } })
    expect(await screen.findByText(/NEWMONTH KOFI/)).toBeInTheDocument()
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText(/OLDMONTH/)).not.toBeInTheDocument()
    expect(screen.getByText(/NEWMONTH KOFI/)).toBeInTheDocument()
  })

  it('offers the last 24 months in a dropdown, newest first, with the opened month kept', async () => {
    renderScreen([claim('1', 'ALPHA')], { initialMonth: '2020-01' })
    await screen.findByText(/ALPHA KOFI/)
    const select = screen.getByLabelText('Month')
    expect(select.tagName).toBe('SELECT')
    const values = within(select).getAllByRole('option').map((option) => option.value)
    expect(values).toHaveLength(25)
    expect([...values].sort().reverse()).toEqual(values)
    expect(values).toContain('2020-01')
    expect(select).toHaveValue('2020-01')
  })

  it('pages through a long month 50 claims at a time', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => claim(String(index + 1), `NAME${String(index + 1).padStart(3, '0')}`))
    renderScreen(rows)
    await screen.findByText(/NAME001 KOFI/)
    expect(screen.getAllByRole('row')).toHaveLength(51)
    expect(screen.getByText('1-50 of 120')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('51-100 of 120')).toBeInTheDocument()
    expect(screen.getByText(/NAME051 KOFI/)).toBeInTheDocument()
  })
})
