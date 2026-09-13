import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ActivityLog from './ActivityLog'

const mocks = vi.hoisted(() => ({
  isSupabaseConfigured: vi.fn(),
  invokeTierAccess: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: mocks.isSupabaseConfigured }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ organization: { id: 'org-1' }, loading: false }) }))
vi.mock('../services/tierAccessService', () => ({ invokeTierAccess: mocks.invokeTierAccess }))

const defaultResult = {
  logs: [{
    id: 'log-1', actor_user_id: '11111111-1111-4111-8111-111111111111', actor_name: 'Akosua Claims',
    actor_email: 'akosua@healthflow.test', event_type: 'nhis_claim', entity_type: 'nhis_claims',
    subject: { fields: { Patient: 'Ama Demo', Claim: 'NHIS-001' }, source: 'snapshot' },
    action: 'update', details: { claim_number: 'NHIS-001' }, created_at: '2026-08-15T12:00:00.000Z',
  }],
  total: 101,
  actors: [{
    id: '11111111-1111-4111-8111-111111111111', full_name: 'Akosua Claims',
    email: 'akosua@healthflow.test', is_active: false,
  }],
  eventTypes: ['nhis_claim', 'sale'],
}

describe('ActivityLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.invokeTierAccess.mockResolvedValue(defaultResult)
  })

  it('shows a setup error when HealthFlow Cloud is unavailable', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(false)
    render(<ActivityLog />)
    await waitFor(() => expect(screen.getByText(/healthflow cloud is not configured/i)).toBeInTheDocument())
    expect(mocks.invokeTierAccess).not.toHaveBeenCalled()
  })

  it('loads activity through the server-filtered tenant access path and shows actor names', async () => {
    render(<ActivityLog />)
    await waitFor(() => expect(screen.getByText('Akosua Claims')).toBeInTheDocument())

    expect(mocks.invokeTierAccess).toHaveBeenCalledWith(expect.objectContaining({
      action: 'get_activity_logs', page: 1, pageSize: 100, actorUserId: null,
      eventType: null, search: null,
    }))
    expect(screen.getByText(/showing records 1-1 of 101/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })

  it('sends date, officer, event, and text filters to the server before pagination', async () => {
    render(<ActivityLog />)
    await waitFor(() => expect(screen.getByText('Akosua Claims')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-31' } })
    fireEvent.change(screen.getByLabelText('Claims officer'), { target: { value: '11111111-1111-4111-8111-111111111111' } })
    fireEvent.change(screen.getByLabelText('Activity type'), { target: { value: 'nhis_claim' } })
    fireEvent.change(screen.getByRole('searchbox', { name: /search activity logs/i }), { target: { value: 'NHIS-001' } })

    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'get_activity_logs', page: 1, fromDate: '2026-08-01', toDate: '2026-08-31',
      actorUserId: '11111111-1111-4111-8111-111111111111', eventType: 'nhis_claim', search: 'NHIS-001',
    })))
  })

  it('resets to the first page when a filter changes and uses the filtered total for pagination', async () => {
    render(<ActivityLog />)
    await waitFor(() => expect(screen.getByText('Page 1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })))

    fireEvent.change(screen.getByRole('searchbox', { name: /search activity logs/i }), { target: { value: 'claim' } })
    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, search: 'claim' })))
  })

  it('shows the full officer count, hides stale totals while filtering, and shows zero matches', async () => {
    render(<ActivityLog />)
    const count = screen.getByRole('status', { name: 'Matching activity count' })
    await waitFor(() => expect(count).toHaveTextContent('101'))

    let resolveOfficer
    mocks.invokeTierAccess.mockImplementationOnce(() => new Promise((resolve) => { resolveOfficer = resolve }))
    fireEvent.change(screen.getByLabelText('Claims officer'), { target: { value: defaultResult.actors[0].id } })
    expect(count).toHaveTextContent('Activities by Akosua Claims')
    expect(count).toHaveTextContent('Loading...')
    expect(count).not.toHaveTextContent('101')
    await act(async () => resolveOfficer({ ...defaultResult, total: 1234 }))
    expect(count).toHaveTextContent('1,234')

    mocks.invokeTierAccess.mockResolvedValueOnce({ ...defaultResult, logs: [], total: 0 })
    fireEvent.change(screen.getByLabelText('Activity type'), { target: { value: 'sale' } })
    await waitFor(() => expect(count).toHaveAttribute('aria-busy', 'false'))
    expect(count.querySelector('strong')).toHaveTextContent(/^0$/)

    fireEvent.change(screen.getByLabelText('Claims officer'), { target: { value: '' } })
    await waitFor(() => expect(count).toHaveTextContent('101'))
    expect(count).toHaveTextContent('Activities by all claims officers')
  })

  it('numbers activities continuously across pages', async () => {
    render(<ActivityLog />)
    await waitFor(() => expect(screen.getByRole('cell', { name: '1', exact: true })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(screen.getByRole('cell', { name: '101', exact: true })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Claims officer'), { target: { value: defaultResult.actors[0].id } })
    await waitFor(() => expect(screen.getByRole('cell', { name: '1', exact: true })).toBeInTheDocument())
  })
})


describe('Activity Log month and record controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.invokeTierAccess.mockResolvedValue(defaultResult)
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  })
  it('offers all months with a year and composes filters before paging', async () => {
    render(<ActivityLog />)
    await screen.findByText('Ama Demo', { exact: false })
    fireEvent.change(screen.getByLabelText('Date period'), { target: { value: 'month' } })
    expect(screen.getByLabelText('Month').options).toHaveLength(13)
    expect(screen.getByLabelText('Month')).toHaveTextContent('All MonthsJanuaryFebruaryMarchAprilMayJuneJulyAugustSeptemberOctoberNovemberDecember')
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2026' } })
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('Claims officer'), { target: { value: defaultResult.actors[0].id } })
    fireEvent.change(screen.getByLabelText('Activity type'), { target: { value: 'nhis_claim' } })
    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'month', year: 2026, month: '9', actorUserId: defaultResult.actors[0].id, eventType: 'nhis_claim', page: 1 })))
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'month', month: '9', page: 2 })))
    expect(screen.getByRole('status', { name: 'Matching activity count' })).toHaveTextContent('101')
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } })
    expect(screen.getByLabelText('Date period')).toHaveValue('custom')
    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'custom', page: 1, fromDate: '2026-08-01' })))
  })
  it('opens readable details without raw JSON or technical identifiers', async () => {
    render(<ActivityLog />)
    fireEvent.click(await screen.findByText('View Details'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Ama Demo')
    expect(dialog).toHaveTextContent('NHIS-001')
    expect(dialog).not.toHaveTextContent(defaultResult.logs[0].actor_user_id)
    fireEvent.click(screen.getByText('Close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('keeps inactive officers searchable and selected by ID', async () => {
    render(<ActivityLog />)
    await screen.findByText('Akosua Claims')
    fireEvent.change(screen.getByLabelText('Find officer'), { target: { value: 'Akosua' } })
    expect(screen.getByLabelText('Claims officer')).toHaveTextContent('inactive')
    fireEvent.change(screen.getByLabelText('Claims officer'), { target: { value: defaultResult.actors[0].id } })
    await waitFor(() => expect(mocks.invokeTierAccess).toHaveBeenLastCalledWith(expect.objectContaining({ actorUserId: defaultResult.actors[0].id })))
  })
  it.each([
    [{ fields: {}, restricted: true }, 'Record details restricted'],
    [{ fields: {}, source: 'unavailable' }, 'Record details unavailable'],
    [{ fields: { Medicine: 'Paracetamol', Strength: '500 mg' }, source: 'current' }, 'Paracetamol'],
  ])('handles restricted, deleted, and medicine records', async (subject, label) => {
    mocks.invokeTierAccess.mockResolvedValue({ ...defaultResult, logs: [{ ...defaultResult.logs[0], subject }] })
    render(<ActivityLog />)
    expect(await screen.findByText(label, { exact: false })).toBeInTheDocument()
  })
})
