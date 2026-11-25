import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Accounting from './Accounting'

const mocks = vi.hoisted(() => ({
  addCashbookEntry: vi.fn(),
  cancelExpense: vi.fn(),
  closeCashbookSession: vi.fn(),
  createExpense: vi.fn(),
  downloadCsv: vi.fn(),
  getAccountingOverview: vi.fn(),
  getBranches: vi.fn(),
  getCashbookSessions: vi.fn(),
  getExpenseCategories: vi.fn(),
  getExpenses: vi.fn(),
  getReceivables: vi.fn(),
  getNhisNotYetSubmittedSummary: vi.fn(),
  getReceivablesSummary: vi.fn(),
  getShifts: vi.fn(),
  getTodaySession: vi.fn(),
  isSupabaseConfigured: vi.fn(),
  notify: vi.fn(),
  openCashbookSession: vi.fn(),
  recordClaimPayment: vi.fn(),
  useAuth: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: mocks.useAuth,
}))

vi.mock('../context/NotificationContext', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: mocks.isSupabaseConfigured,
}))

vi.mock('../services/branchService', () => ({
  getBranches: mocks.getBranches,
}))

vi.mock('../services/expenseService', () => ({
  getExpenses: mocks.getExpenses,
  createExpense: mocks.createExpense,
  cancelExpense: mocks.cancelExpense,
  getExpenseCategories: mocks.getExpenseCategories,
}))

vi.mock('../services/cashbookService', () => ({
  getCashbookSessions: mocks.getCashbookSessions,
  getTodaySession: mocks.getTodaySession,
  openCashbookSession: mocks.openCashbookSession,
  closeCashbookSession: mocks.closeCashbookSession,
  addCashbookEntry: mocks.addCashbookEntry,
}))

vi.mock('../services/receivablesService', () => ({
  getReceivables: mocks.getReceivables,
  getNhisNotYetSubmittedSummary: mocks.getNhisNotYetSubmittedSummary,
  recordClaimPayment: mocks.recordClaimPayment,
  getReceivablesSummary: mocks.getReceivablesSummary,
}))

vi.mock('../services/accountingService', () => ({
  getAccountingOverview: mocks.getAccountingOverview,
}))

vi.mock('../services/shiftService', () => ({
  getShifts: mocks.getShifts,
}))

vi.mock('../services/reportsService', () => ({
  downloadCsv: mocks.downloadCsv,
}))

describe('Accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    mocks.useAuth.mockReturnValue({
      user: { id: 'user-1' },
    })
    mocks.isSupabaseConfigured.mockReturnValue(false)
  })

  it('restores and persists the selected accounting tab for the current browser tab', () => {
    window.sessionStorage.setItem('healthflow.accounting.activeTab', JSON.stringify('cashbook'))

    render(
      <MemoryRouter>
        <Accounting />
      </MemoryRouter>
    )

    expect(
      screen.getByText(/select a specific branch to open or manage today's cashbook session/i)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /receivables/i }))

    expect(window.sessionStorage.getItem('healthflow.accounting.activeTab')).toBe(
      JSON.stringify('receivables')
    )
    expect(
      screen.getByText(/no submitted or approved claims are waiting for payment/i)
    ).toBeInTheDocument()
  })

  const overview = (receivables = {}) => ({
    sales: { revenue: 0, cogs: 0, byMethod: {}, count: 0 },
    expenses: { totalExpenses: 0, byCategory: {} },
    receivables: { totalOutstanding: 500, count: 3, byInsurer: [], byAgeBucket: {}, missing: [], ...receivables },
    cashbook: { totalVariance: 0, shortages: 0 },
    grossProfit: 0,
    grossMarginPct: 0,
    netOperatingProfit: 0,
    warnings: [],
  })

  const renderOverview = () => {
    mocks.isSupabaseConfigured.mockReturnValue(true)
    mocks.getBranches.mockResolvedValue([])
    render(
      <MemoryRouter>
        <Accounting />
      </MemoryRouter>
    )
  }

  const card = (label) => screen.getByText(label).closest('.acc-kpi')

  it('shows served but unsubmitted claims apart from the money owed', async () => {
    mocks.getAccountingOverview.mockResolvedValue(overview())
    mocks.getNhisNotYetSubmittedSummary.mockResolvedValue({ total: 9000, count: 42 })
    renderOverview()

    await screen.findByText(/42 served claims not marked submitted/)
    expect(card('NHIS Not Yet Submitted')).toHaveTextContent('9,000.00')
    expect(card('NHIS Not Yet Submitted')).toHaveTextContent('Not counted as receivables')
    expect(card('Outstanding Receivables')).toHaveTextContent('500.00')
    expect(card('Outstanding Receivables')).not.toHaveTextContent('9,500.00')
    expect(card('Till Sales Revenue')).toHaveTextContent('NHIS claims are not included')
  })

  it('shows a dash, not zero, when the not-yet-submitted figure cannot be loaded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.getAccountingOverview.mockResolvedValue(overview())
    mocks.getNhisNotYetSubmittedSummary.mockRejectedValue(new Error('timed out'))
    renderOverview()

    await screen.findByText(/Could not be loaded\. Press Generate to try again/)
    expect(card('NHIS Not Yet Submitted')).toHaveTextContent('—')
    expect(card('NHIS Not Yet Submitted')).not.toHaveTextContent('0.00')
  })

  it('does not hold up the other figures while the served claims are being added up', async () => {
    mocks.getAccountingOverview.mockResolvedValue(overview())
    mocks.getNhisNotYetSubmittedSummary.mockReturnValue(new Promise(() => {}))
    renderOverview()

    expect(await screen.findByText('Outstanding Receivables')).toBeInTheDocument()
    expect(card('NHIS Not Yet Submitted')).toHaveTextContent('Adding up served claims')
  })

  it('says when part of the receivables could not be loaded', async () => {
    mocks.getAccountingOverview.mockResolvedValue(overview({ missing: ['NHIS claims'] }))
    mocks.getNhisNotYetSubmittedSummary.mockResolvedValue({ total: 0, count: 0 })
    renderOverview()

    expect(await screen.findByText('Incomplete: NHIS claims could not be loaded.')).toBeInTheDocument()
  })

  it('requires a branch before recording an expense', () => {
    render(
      <MemoryRouter>
        <Accounting />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: /expenses/i }))
    fireEvent.click(screen.getByRole('button', { name: /new expense/i }))
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Till paper' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /save expense/i }))

    expect(screen.getByText(/select a branch before recording an expense/i)).toBeInTheDocument()
    expect(mocks.createExpense).not.toHaveBeenCalled()
  })
})
