import { fireEvent, render, screen } from '@testing-library/react'
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
  getReceivablesSummary: vi.fn(),
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
  recordClaimPayment: mocks.recordClaimPayment,
  getReceivablesSummary: mocks.getReceivablesSummary,
}))

vi.mock('../services/accountingService', () => ({
  getAccountingOverview: mocks.getAccountingOverview,
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

    render(<Accounting />)

    expect(
      screen.getByText(/select a specific branch to open or manage today's cashbook session/i)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /receivables/i }))

    expect(window.sessionStorage.getItem('healthflow.accounting.activeTab')).toBe(
      JSON.stringify('receivables')
    )
    expect(
      screen.getByText(/no outstanding receivables\. all approved claims are fully paid/i)
    ).toBeInTheDocument()
  })
})
