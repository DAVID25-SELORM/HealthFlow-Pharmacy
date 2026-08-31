import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ActivityLog from './ActivityLog'

const mocks = vi.hoisted(() => {
  const queryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    gte: vi.fn(),
    lt: vi.fn(),
    range: vi.fn(),
  }

  queryBuilder.select.mockImplementation(() => queryBuilder)
  queryBuilder.eq.mockImplementation(() => queryBuilder)
  queryBuilder.order.mockImplementation(() => queryBuilder)
  queryBuilder.gte.mockImplementation(() => queryBuilder)
  queryBuilder.lt.mockImplementation(() => queryBuilder)

  return {
    isSupabaseConfigured: vi.fn(),
    invokeTierAccess: vi.fn(),
    queryBuilder,
    supabase: {
      from: vi.fn(() => queryBuilder),
    },
  }
})

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
  supabase: mocks.supabase,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    organization: { id: 'org-1' },
  }),
}))

vi.mock('../services/tierAccessService', () => ({
  invokeTierAccess: mocks.invokeTierAccess,
}))

describe('ActivityLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryBuilder.range.mockResolvedValue({ data: [], error: null, count: 0 })
  })

  it('shows a setup error when HealthFlow Cloud is unavailable', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(false)

    render(<ActivityLog />)

    await waitFor(() => {
      expect(screen.getByText(/healthflow cloud is not configured/i)).toBeInTheDocument()
    })

    expect(mocks.supabase.from).not.toHaveBeenCalled()
  })

  it('renders logs and filters them with search', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.queryBuilder.range.mockResolvedValue({
      data: [
        {
          id: 'log-1',
          actor_user_id: 'user-1',
          actor_email: 'admin@healthflow.test',
          event_type: 'sale',
          entity_type: 'sales',
          action: 'create',
          details: { sale_number: 'S-1001', amount: 45.5 },
          created_at: '2026-04-24T10:00:00.000Z',
        },
        {
          id: 'log-2',
          actor_user_id: 'user-2',
          actor_email: 'admin@healthflow.test',
          event_type: 'patient',
          entity_type: 'patients',
          action: 'update',
          details: { patient_name: 'Ama Boateng' },
          created_at: '2026-04-24T11:00:00.000Z',
        },
      ],
      error: null,
      count: 2,
    })

    render(<ActivityLog />)

    await waitFor(() => {
      expect(screen.getByText(/showing 1-2 of 2 records/i)).toBeInTheDocument()
    })

    fireEvent.change(screen.getByRole('searchbox', { name: /search activity logs/i }), {
      target: { value: 'boateng' },
    })

    await waitFor(() => {
      expect(screen.getByText(/showing 1 matching record on this page/i)).toBeInTheDocument()
    })
  })

  it('uses details email when actor columns are empty', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.queryBuilder.range.mockResolvedValue({
      data: [
        {
          id: 'log-1',
          actor_user_id: null,
          actor_email: null,
          event_type: 'auth',
          entity_type: 'session',
          action: 'sign_in',
          details: { email: 'staff@healthflow.test' },
          created_at: '2026-05-09T17:49:41.000Z',
        },
      ],
      error: null,
      count: 1,
    })

    render(<ActivityLog />)

    await waitFor(() => {
      expect(screen.getByText('staff@healthflow.test')).toBeInTheDocument()
    })

    expect(screen.queryByText('Unknown')).not.toBeInTheDocument()
  })

  it('loads facility activity directly through organization-scoped RLS', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.queryBuilder.range.mockResolvedValue({
      data: [
        {
          id: 'log-1',
          actor_user_id: 'user-1',
          actor_email: 'admin@healthflow.test',
          event_type: 'auth',
          entity_type: 'session',
          action: 'sign_in',
          details: { email: 'admin@healthflow.test' },
          created_at: '2026-06-22T08:00:00.000Z',
        },
      ],
      error: null,
      count: 1,
    })

    render(<ActivityLog />)

    await waitFor(() => {
      expect(screen.getByText(/showing 1-1 of 1 records/i)).toBeInTheDocument()
    })

    expect(mocks.supabase.from).toHaveBeenCalledWith('audit_logs')
    expect(mocks.queryBuilder.eq).toHaveBeenCalledWith('organization_id', 'org-1')
    expect(mocks.queryBuilder.range).toHaveBeenCalledWith(0, 99)
    expect(mocks.invokeTierAccess).not.toHaveBeenCalled()
  })

  it('loads later pages and applies an inclusive date range on the server', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.queryBuilder.range.mockResolvedValue({ data: [], error: null, count: 250 })

    render(<ActivityLog />)

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(mocks.queryBuilder.range).toHaveBeenLastCalledWith(100, 199))

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-15' } })

    await waitFor(() => {
      expect(mocks.queryBuilder.gte).toHaveBeenCalledWith('created_at', '2026-08-01T00:00:00+00:00')
      expect(mocks.queryBuilder.lt).toHaveBeenCalledWith('created_at', '2026-08-16T00:00:00.000Z')
      expect(mocks.queryBuilder.range).toHaveBeenLastCalledWith(0, 99)
    })
  })
})
