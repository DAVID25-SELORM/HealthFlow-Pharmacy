import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ActivityLog from './ActivityLog'

const mocks = vi.hoisted(() => {
  const queryBuilder = {
    select: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  }

  queryBuilder.select.mockImplementation(() => queryBuilder)
  queryBuilder.order.mockImplementation(() => queryBuilder)

  return {
    isSupabaseConfigured: vi.fn(),
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

describe('ActivityLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a setup error when Supabase is unavailable', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(false)

    render(<ActivityLog />)

    await waitFor(() => {
      expect(screen.getByText(/supabase is not configured/i)).toBeInTheDocument()
    })

    expect(mocks.supabase.from).not.toHaveBeenCalled()
  })

  it('renders logs and filters them with search', async () => {
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.queryBuilder.limit.mockResolvedValue({
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
    })

    render(<ActivityLog />)

    await waitFor(() => {
      expect(screen.getByText(/showing 2 of 2 records/i)).toBeInTheDocument()
    })

    fireEvent.change(screen.getByRole('searchbox', { name: /search activity logs/i }), {
      target: { value: 'boateng' },
    })

    await waitFor(() => {
      expect(screen.getByText(/showing 1 of 2 records/i)).toBeInTheDocument()
    })
  })
})
