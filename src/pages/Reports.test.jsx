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
      id: 'nhis-insulin',
      claim_number: 'NHIS-000016',
      surname: 'ARMAH',
      other_names: 'ABRAHAM NII ADAMAH',
      member_no: '15171866',
      insurance_provider: 'NHIS',
      status: 'served',
      total_amount: 587.52,
      service_date_from: '2026-06-09',
      physician_name: 'DR. ANGELINA KUMI',
      folder_no: '833357',
      nhis_claim_medicines: [{
        id: 'nhis-insulin-line',
        drug_code: 'INPRMIIN1',
        description: 'Insulin premixed (30/70) HM Injection, 100 units/mL in 10 mL',
        dispensed_qty: 6,
        unit: 'Vial',
        unit_price: 84.42,
        total_amount: 506.52,
      }],
    },
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
    const { container } = render(<Reports />)

    await waitFor(() => {
      expect(screen.getAllByText('Sales/POS Report').length).toBeGreaterThan(0)
    })

    const reportTableCard = container.querySelector('.report-table-card')
    expect(reportTableCard).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: /^Generate$/i })[0])
    expect(await within(reportTableCard).findByText('SALE-001')).toBeInTheDocument()
    expect(within(reportTableCard).getByText('SALE-002')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/search reports/i), { target: { value: 'Kojo' } })
    expect(within(reportTableCard).queryByText('SALE-001')).not.toBeInTheDocument()
    expect(within(reportTableCard).getByText('SALE-002')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('tab', { name: /NHIS Claims/i }))
    expect(screen.getByText('NHIS Medicines Dispensed Report')).toBeInTheDocument()
    expect(screen.getByText('Tariff/GDRG Services Report')).toBeInTheDocument()

    const gdrgCard = screen.getByText('Tariff/GDRG Services Report').closest('.report-card')
    fireEvent.click(within(gdrgCard).getByRole('button', { name: /^Generate$/i }))
    expect(await screen.findByText('GDRG-01')).toBeInTheDocument()
    expect(screen.getByText('Consultation')).toBeInTheDocument()
  })

  it('shows drug utilization analytics with fast search and patient drill down', async () => {
    render(<Reports />)

    await waitFor(() => {
      expect(screen.getByText('Drug Utilization Report')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Generate Reports/i }))
    await waitFor(() => {
      expect(mocks.getReportBundle).toHaveBeenCalled()
    })

    expect(screen.getAllByText('Top 10 Dispensed Drugs').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText(/fast search drug utilization/i), { target: { value: 'Amoxicillin' } })
    expect((await screen.findAllByText('2 patients')).length).toBeGreaterThan(0)

    const amoxicillinButton = screen.getByRole('button', { name: /Amoxicillin Capsules/i })
    fireEvent.click(amoxicillinButton)
    expect(screen.getByText('Amoxicillin Capsules - Patients Given This Drug')).toBeInTheDocument()
    expect(screen.getByText('2 dispensing records found for Amoxicillin Capsules.')).toBeInTheDocument()
    expect(screen.getAllByText('Ama Mensah').length).toBeGreaterThan(0)
    expect(screen.getAllByText('SALE-001').length).toBeGreaterThan(0)
    expect(screen.getAllByText('NHIA-001').length).toBeGreaterThan(0)
    expect(screen.getByText('View patients who received this drug')).toBeInTheDocument()
  })

  it('finds served NHIS medicines stored with claim schema field names', async () => {
    render(<Reports />)

    await waitFor(() => {
      expect(screen.getByLabelText(/fast search drug utilization/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /Generate Reports/i }))
    await waitFor(() => {
      expect(mocks.getReportBundle).toHaveBeenCalled()
    })

    fireEvent.change(screen.getByLabelText(/fast search drug utilization/i), {
      target: { value: 'INSULI' },
    })

    expect(await screen.findByText(/Insulin premixed \(30\/70\)/i)).toBeInTheDocument()
    expect(screen.getAllByText('6 Vial')).toHaveLength(2)
    expect(screen.getByText('ARMAH ABRAHAM NII ADAMAH')).toBeInTheDocument()
    expect(screen.getByText('NHIS-000016')).toBeInTheDocument()
  })

  it('keeps report tabs and preview navigation in sync', async () => {
    render(<Reports />)

    await waitFor(() => {
      expect(screen.getByText('Drug Utilization Report')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('tab', { name: /Accounting/i }))
    expect(screen.getByRole('tab', { name: /Accounting/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('heading', { name: 'Accounting/Cashier Shifts Report' }).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('tab', { name: /Drug Utilization/i }))
    expect(screen.getByRole('tab', { name: /Drug Utilization/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('heading', { name: 'Drug Utilization Report' }).length).toBeGreaterThan(0)
  })

  it('opens the selected medicine drill down and shows unavailable tab feedback', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { unmount } = render(<Reports />)

    fireEvent.click(screen.getByRole('button', { name: /Generate Reports/i }))
    await waitFor(() => expect(mocks.getReportBundle).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText(/fast search drug utilization/i), {
      target: { value: 'Amoxicillin' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Amoxicillin Capsules/i }))
    fireEvent.click(screen.getByRole('button', { name: /Open Drill Down/i }))

    expect(screen.getAllByRole('heading', { name: 'Patient-Level Drug Drill Down' }).length).toBeGreaterThan(0)
    expect(screen.getByText(/Opened the patient drill down for Amoxicillin Capsules/i)).toBeInTheDocument()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())

    unmount()
    mocks.useAuth.mockReturnValue({
      role: 'cashier',
      displayName: 'Cashier',
      branch: { id: 'branch-1', name: 'Main Branch' },
    })
    render(<Reports />)
    fireEvent.click(screen.getByRole('tab', { name: /NHIS Claims/i }))
    expect(screen.getByText(/NHIS Claims is not available yet.*future update/i)).toBeInTheDocument()
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
