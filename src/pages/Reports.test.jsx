import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Reports from './Reports'

const mocks = vi.hoisted(() => ({
  downloadCsv: vi.fn(),
  getReportBundle: vi.fn(),
  isSupabaseConfigured: vi.fn(),
  useTenant: vi.fn(),
}))

vi.mock('../context/TenantContext', () => ({
  useTenant: mocks.useTenant,
}))

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
}))

vi.mock('../services/reportsService', () => ({
  downloadCsv: mocks.downloadCsv,
  getReportBundle: mocks.getReportBundle,
}))

const reportBundle = {
  metrics: {
    salesCount: 2,
    salesAmount: 50,
    lowStockCount: 0,
    expiredCount: 0,
    expiringCount: 0,
    patientCount: 2,
    inventoryCount: 2,
    soldLineItems: 2,
    unitsSold: 3,
    claimsCount: 0,
    approvedClaims: 0,
    rejectedClaims: 0,
    dailySales: {
      '2026-06-01': 50,
    },
  },
  patients: [
    {
      id: 'patient-1',
      full_name: 'Ama Mensah',
      phone: '0244000001',
      insurance_provider: 'NHIS',
      insurance_id: 'NHIS-1234',
    },
    {
      id: 'patient-2',
      full_name: 'Kojo Appiah',
      phone: '0555000002',
      insurance_provider: 'Private Health',
      insurance_id: 'PRV-9988',
    },
  ],
  sales: [
    {
      id: 'sale-1',
      sale_number: 'SALE-001',
      sale_date: '2026-06-01T09:00:00Z',
      patient_id: 'patient-1',
      patients: null,
      payment_method: 'Cash',
      payment_status: 'paid',
      net_amount: 30,
      total_amount: 30,
      sale_items: [
        {
          id: 'item-1',
          drug_name: 'Amoxicillin Capsules',
          quantity: 1,
          unit_price: 30,
          total_price: 30,
        },
      ],
    },
    {
      id: 'sale-2',
      sale_number: 'SALE-002',
      sale_date: '2026-06-01T10:00:00Z',
      patient_id: 'patient-2',
      patients: null,
      payment_method: 'Mobile Money',
      payment_status: 'paid',
      net_amount: 20,
      total_amount: 20,
      sale_items: [
        {
          id: 'item-2',
          drug_name: 'Paracetamol Tablets',
          quantity: 2,
          unit_price: 10,
          total_price: 20,
        },
      ],
    },
  ],
  claims: [],
}

describe('Reports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useTenant.mockReturnValue({
      canUseClaims: false,
      tierLimits: {
        hasClaims: false,
        hasReports: true,
      },
    })
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.getReportBundle.mockResolvedValue(reportBundle)
  })

  it('filters the sold items ledger by visible sale, patient, item, insurance, and payment values', async () => {
    render(<Reports />)

    await waitFor(() => {
      expect(screen.getByText('Amoxicillin Capsules')).toBeInTheDocument()
    })
    expect(screen.getByText('Paracetamol Tablets')).toBeInTheDocument()

    const ledgerSearch = screen.getByLabelText(/search sold items ledger/i)

    fireEvent.change(ledgerSearch, { target: { value: 'paracetamol' } })
    expect(screen.queryByText('Amoxicillin Capsules')).not.toBeInTheDocument()
    expect(screen.getByText('Paracetamol Tablets')).toBeInTheDocument()
    expect(screen.getByText('1 rows')).toBeInTheDocument()

    fireEvent.change(ledgerSearch, { target: { value: 'nhis1234' } })
    expect(screen.getByText('Amoxicillin Capsules')).toBeInTheDocument()
    expect(screen.queryByText('Paracetamol Tablets')).not.toBeInTheDocument()

    fireEvent.change(ledgerSearch, { target: { value: 'mobile money' } })
    expect(screen.queryByText('Amoxicillin Capsules')).not.toBeInTheDocument()
    expect(screen.getByText('Paracetamol Tablets')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    expect(screen.getByText('Amoxicillin Capsules')).toBeInTheDocument()
    expect(screen.getByText('Paracetamol Tablets')).toBeInTheDocument()
    expect(screen.getByText('2 rows')).toBeInTheDocument()
  })
})
