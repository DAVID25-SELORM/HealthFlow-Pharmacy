import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Reports from './Reports'
import {
  REPORT_CATALOG,
  REPORT_TABS,
  buildReportHeaderRows,
  canAccessReport,
  getVisibleReportCatalog,
  normalizeReportBundle,
} from '../services/reportsService'

const mocks = vi.hoisted(() => ({
  getReportBundle: vi.fn(),
  getPharmacySettings: vi.fn(),
  useAuth: vi.fn(),
  useTenant: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: mocks.useAuth,
}))

vi.mock('../context/TenantContext', () => ({
  useTenant: mocks.useTenant,
}))

vi.mock('../services/settingsService', () => ({
  getPharmacySettings: mocks.getPharmacySettings,
}))

vi.mock('../services/reportsService', async () => {
  const actual = await vi.importActual('../services/reportsService')
  return {
    ...actual,
    downloadCsv: vi.fn(),
    exportReportPdf: vi.fn(),
    getReportBundle: mocks.getReportBundle,
    printReport: vi.fn(),
  }
})

const reportBundle = {
  source: 'test',
  metrics: {
    salesCount: 2,
    salesAmount: 50,
    lowStockCount: 1,
    expiredCount: 0,
    expiringCount: 1,
    patientCount: 2,
    inventoryCount: 2,
    soldLineItems: 2,
    unitsSold: 3,
    claimsCount: 0,
    nhisClaimsCount: 2,
    approvedNhisClaims: 1,
    rejectedNhisClaims: 1,
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
      patients: { full_name: 'Ama Mensah' },
      payment_method: 'cash',
      payment_status: 'completed',
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
      patients: { full_name: 'Kojo Appiah' },
      payment_method: 'momo',
      payment_status: 'completed',
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
  nhisClaims: [
    {
      id: 'nhis-1',
      claimNumber: 'NHIA-001',
      patientName: 'Ama Mensah',
      insuranceProvider: 'NHIS',
      status: 'accepted',
      totalAmount: 30,
      serviceDate: '2026-06-01',
      items: [{ id: 'nhis-item-1', drugName: 'Amoxicillin Capsules', quantity: 1, unitPrice: 30, totalPrice: 30 }],
    },
    {
      id: 'nhis-2',
      claimNumber: 'NHIA-002',
      patientName: 'Kojo Appiah',
      insuranceProvider: 'NHIS',
      status: 'failed',
      totalAmount: 20,
      serviceDate: '2026-06-01',
      unservedMedicinesNote: 'Paracetamol unavailable',
      items: [{ id: 'nhis-item-2', drugName: 'Paracetamol Tablets', quantity: 2, unitPrice: 10, totalPrice: 20 }],
      services: [{ id: 'svc-1', gdrgCode: 'GDRG-01', description: 'Consultation', quantity: 1, totalAmount: 12 }],
    },
  ],
  drugs: [
    { id: 'drug-1', name: 'Amoxicillin Capsules', quantity: 4, reorder_level: 5, expiry_date: '2026-06-20' },
    { id: 'drug-2', name: 'Paracetamol Tablets', quantity: 20, reorder_level: 5, expiry_date: '2027-01-01' },
  ],
  lowStock: [{ id: 'drug-1', name: 'Amoxicillin Capsules', quantity: 4, reorder_level: 5 }],
  expiring: [{ id: 'drug-1', name: 'Amoxicillin Capsules', quantity: 4, expiry_date: '2026-06-20' }],
  expired: [],
  purchases: [],
  suppliers: [],
  exportHistory: [],
  submissionLogs: [
    { id: 'log-1', action: 'cc_code.generate.complete', status: 'success', createdAt: '2026-06-01T09:00:00Z' },
  ],
  monthlyNhisSubmission: [{ month: '2026-06', count: 2, totalAmount: 50, accepted: 1, rejected: 1, pending: 0 }],
  staffActivity: [],
}

describe('Reports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useAuth.mockReturnValue({
      role: 'admin',
      displayName: 'Admin User',
      branch: { id: 'branch-1', name: 'Main Branch' },
    })
    mocks.useTenant.mockReturnValue({
      organization: { name: 'HealthFlow Test Pharmacy', nhis_code: 'NHIS-001' },
      canUseClaims: true,
      tierLimits: {
        hasClaims: true,
        hasReports: true,
      },
    })
    mocks.getPharmacySettings.mockResolvedValue({})
    mocks.getReportBundle.mockResolvedValue(reportBundle)
  })

  it('generates report cards and filters the selected report rows by visible values', async () => {
    render(<Reports />)

    await waitFor(() => {
      expect(screen.getAllByText('Sales/POS Report').length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getAllByRole('button', { name: /^Generate$/i })[0])
    expect(screen.getByText('SALE-001')).toBeInTheDocument()
    expect(screen.getByText('SALE-002')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/search reports/i), { target: { value: 'Kojo' } })
    expect(screen.queryByText('SALE-001')).not.toBeInTheDocument()
    expect(screen.getByText('SALE-002')).toBeInTheDocument()
    expect(screen.getByText('1 rows')).toBeInTheDocument()
  })

  it('shows NHIS reports with medicine and GDRG report generation for authorized claims staff', async () => {
    mocks.useAuth.mockReturnValue({
      role: 'claims_officer',
      displayName: 'Claims Officer',
      branch: { id: 'branch-1', name: 'Main Branch' },
    })

    render(<Reports />)

    await waitFor(() => {
      expect(screen.getAllByText('NHIS Claims Summary').length).toBeGreaterThan(0)
    })

    expect(screen.queryByText('Sales/POS Report')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /NHIS Claims/i }))
    expect(screen.getByText('NHIS Medicines Dispensed Report')).toBeInTheDocument()
    expect(screen.getByText('Tariff/GDRG Services Report')).toBeInTheDocument()

    const gdrgCard = screen.getByText('Tariff/GDRG Services Report').closest('.report-card')
    fireEvent.click(within(gdrgCard).getByRole('button', { name: /^Generate$/i }))
    expect(screen.getByText('GDRG-01')).toBeInTheDocument()
    expect(screen.getByText('Consultation')).toBeInTheDocument()
  })

  it('shows drug utilization analytics with fast search and patient drill down', async () => {
    render(<Reports />)

    await waitFor(() => {
      expect(screen.getByText('Drug Utilization Report')).toBeInTheDocument()
    })

    expect(screen.getAllByText('Top 10 Dispensed Drugs').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText(/fast search drug utilization/i), { target: { value: 'Amoxicillin' } })
    expect(screen.getAllByText('2 patients').length).toBeGreaterThan(0)

    const amoxicillinButton = screen.getByRole('button', { name: /Amoxicillin Capsules/i })
    fireEvent.click(amoxicillinButton)
    expect(screen.getByText('Amoxicillin Capsules Patient Drill Down')).toBeInTheDocument()
    expect(screen.getAllByText('Ama Mensah').length).toBeGreaterThan(0)
  })

  it('does not expose the drug analytics panel to roles without analytics reports', async () => {
    mocks.useAuth.mockReturnValue({
      role: 'cashier',
      displayName: 'Cashier User',
      branch: { id: 'branch-1', name: 'Main Branch' },
    })

    render(<Reports />)

    await waitFor(() => {
      expect(screen.getAllByText('Sales/POS Report').length).toBeGreaterThan(0)
    })

    expect(screen.queryByLabelText(/fast search drug utilization/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Drug Utilization Report')).not.toBeInTheDocument()
  })
})

describe('reportsService access helpers', () => {
  it('limits report catalog by role', () => {
    expect(getVisibleReportCatalog('claims_officer').every((report) => report.category === 'nhis')).toBe(true)
    expect(getVisibleReportCatalog('cashier').some((report) => report.id === 'sales-summary')).toBe(true)
    expect(getVisibleReportCatalog('cashier').some((report) => report.id === 'inventory-stock')).toBe(false)
    expect(canAccessReport('inventory_officer', 'purchases')).toBe(true)
    expect(canAccessReport('inventory_officer', 'nhis-summary')).toBe(false)
  })

  it('normalizes report bundle metrics for filtering tests and exposes all tabs', () => {
    const normalized = normalizeReportBundle(reportBundle)
    expect(normalized.metrics.pendingNhisClaims).toBe(1)
    expect(normalized.metrics.approvedNhisClaims).toBe(1)
    expect(REPORT_TABS.map((tab) => tab.id)).toContain('nhis')
    expect(REPORT_TABS.map((tab) => tab.id)).toContain('analytics')
    expect(REPORT_CATALOG.map((report) => report.id)).toContain('cc-code-generation')
    expect(REPORT_CATALOG.map((report) => report.id)).toContain('drug-utilization')
    expect(buildReportHeaderRows({
      title: 'Claims',
      filters: { startDate: '2026-06-01', endDate: '2026-06-30' },
      branding: { facilityName: 'Facility', nhisCode: 'NHIS-001' },
      generatedBy: 'Tester',
      branchName: 'Main',
    }).flat()).toContain('Generated by: Tester')
  })
})
