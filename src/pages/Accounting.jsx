import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DollarSign, TrendingDown, RefreshCcw,
  Plus, X, Calendar, Download, BookOpen, ReceiptText,
  AlertTriangle
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatLocalDate, getFirstDayOfLocalMonth } from '../utils/date'
import { getBranches } from '../services/branchService'
import {
  getExpenses, createExpense, cancelExpense,
  getExpenseCategories,
} from '../services/expenseService'
import {
  getCashbookSessions, getTodaySession,
  openCashbookSession, closeCashbookSession, addCashbookEntry,
} from '../services/cashbookService'
import {
  getReceivables, recordClaimPayment, getReceivablesSummary,
} from '../services/receivablesService'
import { getAccountingOverview } from '../services/accountingService'
import { useSessionStorageState } from '../hooks/useSessionStorageState'
import { downloadCsv } from '../services/reportsService'
import './Accounting.css'

// â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const today = formatLocalDate()
const firstOfMth = getFirstDayOfLocalMonth()
const ACCOUNTING_STORAGE_KEYS = {
  activeTab: 'healthflow.accounting.activeTab',
  branchFilter: 'healthflow.accounting.branchFilter',
  startDate: 'healthflow.accounting.startDate',
  endDate: 'healthflow.accounting.endDate',
}

const fmt = (n) =>
  `GHS ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const PAYMENT_METHODS = ['cash', 'momo', 'bank_transfer', 'cheque', 'other']

const TABS = [
  { key: 'overview',     label: 'Overview',    icon: DollarSign   },
  { key: 'expenses',     label: 'Expenses',    icon: TrendingDown },
  { key: 'cashbook',     label: 'Cashbook',    icon: BookOpen     },
  { key: 'receivables',  label: 'Receivables', icon: ReceiptText  },
]

const isValidDateInput = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const isValidAccountingTab = (value) => TABS.some((tab) => tab.key === value)

const blankExpenseForm = {
  expenseDate: today, description: '', amount: '', categoryId: '',
  paymentMethod: 'cash', vendorName: '', referenceNumber: '', notes: '',
}

const blankPaymentForm = {
  paidAmount: '', paymentDate: today, paymentMethod: 'bank_transfer',
  paymentReference: '', notes: '',
}

// â”€â”€ page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const Accounting = () => {
  const { user } = useAuth()
  const { notify } = useNotification()

  const [activeTab, setActiveTab] = useSessionStorageState(
    ACCOUNTING_STORAGE_KEYS.activeTab,
    'overview',
    {
      validate: isValidAccountingTab,
    }
  )
  const [startDate, setStartDate] = useSessionStorageState(
    ACCOUNTING_STORAGE_KEYS.startDate,
    firstOfMth,
    {
      validate: isValidDateInput,
    }
  )
  const [endDate, setEndDate] = useSessionStorageState(
    ACCOUNTING_STORAGE_KEYS.endDate,
    today,
    {
      validate: isValidDateInput,
    }
  )
  const [branchFilter, setBranchFilter] = useSessionStorageState(
    ACCOUNTING_STORAGE_KEYS.branchFilter,
    'all',
    {
      validate: (value) => typeof value === 'string' && value.length > 0,
    }
  )
  const [branches, setBranches]     = useState([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [overviewWarning, setOverviewWarning] = useState('')

  // Overview
  const [overview, setOverview]     = useState(null)

  // Expenses
  const [expenses, setExpenses]         = useState([])
  const [categories, setCategories]     = useState([])
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [expenseForm, setExpenseForm]   = useState(blankExpenseForm)
  const [savingExpense, setSavingExpense] = useState(false)

  // Cashbook
  const [todaySession, setTodaySession]   = useState(null)
  const [sessions, setSessions]           = useState([])
  const [openingCash, setOpeningCash]     = useState('')
  const [countedCash, setCountedCash]     = useState('')
  const [sessionNotes, setSessionNotes]   = useState('')
  const [closingSession, setClosingSession] = useState(false)
  const [openingSession, setOpeningSession] = useState(false)
  const [adjAmount, setAdjAmount]         = useState('')
  const [adjDirection, setAdjDirection]   = useState('in')
  const [adjDesc, setAdjDesc]             = useState('')
  const [addingEntry, setAddingEntry]     = useState(false)

  // Receivables
  const [receivables, setReceivables]       = useState([])
  const [receivablesSummary, setReceivablesSummary] = useState(null)
  const [payingClaimId, setPayingClaimId]   = useState(null)
  const [payingClaim, setPayingClaim]       = useState(null)
  const [paymentForm, setPaymentForm]       = useState(blankPaymentForm)
  const [savingPayment, setSavingPayment]   = useState(false)

  // â”€â”€ load functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const loadBranches = useCallback(async () => {
    if (!isSupabaseConfigured()) return
    try {
      const data = await getBranches()
      setBranches(data)
    } catch { /* silent */ }
  }, [])

  const loadOverview = useCallback(async () => {
    if (!isSupabaseConfigured()) return
    try {
      setLoading(true)
      setError('')
      const branchId = branchFilter !== 'all' ? branchFilter : null
      const data = await getAccountingOverview(startDate, endDate, branchId)
      setOverview(data)
      setOverviewWarning(
        data.warnings?.length
          ? `Some overview sections could not be loaded: ${data.warnings.join(', ')}. Showing available live data only.`
          : ''
      )
    } catch (err) {
      setOverviewWarning('')
      setError(err.message || 'Failed to load accounting overview.')
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, branchFilter])

  const loadExpenses = useCallback(async () => {
    if (!isSupabaseConfigured()) return
    try {
      setLoading(true)
      setError('')
      setOverviewWarning('')
      const branchId = branchFilter !== 'all' ? branchFilter : null
      const [expData, catData] = await Promise.all([
        getExpenses({ startDate, endDate, branchId }),
        getExpenseCategories(),
      ])
      setExpenses(expData)
      setCategories(catData)
    } catch (err) {
      setError(err.message || 'Failed to load expenses.')
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, branchFilter])

  const loadCashbook = useCallback(async () => {
    if (!isSupabaseConfigured()) return
    try {
      setLoading(true)
      setError('')
      setOverviewWarning('')
      const branchId = branchFilter !== 'all' ? branchFilter : null
      const [sessData, todaySess] = await Promise.all([
        getCashbookSessions({ startDate, endDate, branchId }),
        branchFilter !== 'all' ? getTodaySession(branchFilter) : Promise.resolve(null),
      ])
      setSessions(sessData)
      setTodaySession(todaySess)
    } catch (err) {
      setError(err.message || 'Failed to load cashbook.')
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate, branchFilter])

  const loadReceivables = useCallback(async () => {
    if (!isSupabaseConfigured()) return
    try {
      setLoading(true)
      setError('')
      setOverviewWarning('')
      const branchId = branchFilter !== 'all' ? branchFilter : null
      const [recv, summary] = await Promise.all([
        getReceivables(branchId),
        getReceivablesSummary(branchId),
      ])
      setReceivables(recv)
      setReceivablesSummary(summary)
    } catch (err) {
      setError(err.message || 'Failed to load receivables.')
    } finally {
      setLoading(false)
    }
  }, [branchFilter])

  // â”€â”€ tab routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  useEffect(() => { void loadBranches() }, [loadBranches])

  useEffect(() => {
    if (branchFilter === 'all' || branches.length === 0) {
      return
    }

    if (!branches.some((branch) => branch.id === branchFilter)) {
      setBranchFilter('all')
    }
  }, [branchFilter, branches, setBranchFilter])

  useEffect(() => {
    if (activeTab === 'overview')    void loadOverview()
    if (activeTab === 'expenses')    void loadExpenses()
    if (activeTab === 'cashbook')    void loadCashbook()
    if (activeTab === 'receivables') void loadReceivables()
  }, [activeTab, loadOverview, loadExpenses, loadCashbook, loadReceivables])

  const refresh = () => {
    if (activeTab === 'overview')    void loadOverview()
    if (activeTab === 'expenses')    void loadExpenses()
    if (activeTab === 'cashbook')    void loadCashbook()
    if (activeTab === 'receivables') void loadReceivables()
  }

  // â”€â”€ expense handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const handleCreateExpense = async (e) => {
    e.preventDefault()
    if (!expenseForm.description.trim())   return setError('Description is required.')
    if (!expenseForm.amount || Number(expenseForm.amount) <= 0) return setError('Enter a valid amount.')

    try {
      setSavingExpense(true)
      setError('')
      await createExpense({
        ...expenseForm,
        branchId:  branchFilter !== 'all' ? branchFilter : null,
        createdBy: user?.id,
      })
      notify('Expense recorded.', 'success')
      setShowExpenseForm(false)
      setExpenseForm(blankExpenseForm)
      void loadExpenses()
    } catch (err) {
      setError(err.message || 'Failed to save expense.')
    } finally {
      setSavingExpense(false)
    }
  }

  const handleCancelExpense = async (id) => {
    if (!window.confirm('Cancel this expense record?')) return
    try {
      await cancelExpense(id)
      notify('Expense cancelled.', 'info')
      void loadExpenses()
    } catch (err) {
      notify(err.message || 'Failed to cancel expense.', 'error')
    }
  }

  const exportExpensesCsv = () => {
    if (!expenses.length) return
    const rows = expenses.map((e) => [
      e.expense_date,
      e.expense_categories?.name || '',
      e.description,
      e.amount,
      e.payment_method,
      e.vendor_name || '',
      e.reference_number || '',
      e.status,
      e.branches?.name || '',
    ])
    downloadCsv('expenses-report.csv',
      ['Date','Category','Description','Amount','Payment Method','Vendor','Reference','Status','Branch'],
      rows
    )
  }

  // â”€â”€ cashbook handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const handleOpenSession = async (e) => {
    e.preventDefault()
    if (branchFilter === 'all') return setError('Select a branch to open a cashbook session.')
    try {
      setOpeningSession(true)
      setError('')
      const sess = await openCashbookSession({
        branchId:    branchFilter,
        openingCash: Number(openingCash) || 0,
        openedBy:    user?.id,
      })
      setTodaySession(sess)
      setOpeningCash('')
      notify('Cashbook session opened.', 'success')
      void loadCashbook()
    } catch (err) {
      setError(err.message || 'Failed to open session.')
    } finally {
      setOpeningSession(false)
    }
  }

  const handleCloseSession = async (e) => {
    e.preventDefault()
    if (!todaySession) return
    if (!countedCash) return setError('Enter the counted cash amount.')
    try {
      setClosingSession(true)
      setError('')
      await closeCashbookSession({
        sessionId:   todaySession.id,
        countedCash: Number(countedCash),
        notes:       sessionNotes,
        closedBy:    user?.id,
      })
      setCountedCash('')
      setSessionNotes('')
      notify('Cashbook session closed.', 'success')
      void loadCashbook()
    } catch (err) {
      setError(err.message || 'Failed to close session.')
    } finally {
      setClosingSession(false)
    }
  }

  const handleAddEntry = async (e) => {
    e.preventDefault()
    if (!todaySession) return setError('Open a session first.')
    if (!adjAmount || Number(adjAmount) <= 0) return setError('Enter a valid amount.')
    try {
      setAddingEntry(true)
      setError('')
      await addCashbookEntry({
        sessionId:  todaySession.id,
        branchId:   branchFilter,
        entryType:  'adjustment',
        sourceType: 'manual',
        amount:     Number(adjAmount),
        direction:  adjDirection,
        description: adjDesc,
        createdBy:  user?.id,
      })
      setAdjAmount('')
      setAdjDesc('')
      notify('Entry added.', 'success')
      void loadCashbook()
    } catch (err) {
      setError(err.message || 'Failed to add entry.')
    } finally {
      setAddingEntry(false)
    }
  }

  // â”€â”€ receivables handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const openPaymentModal = (claim) => {
    setPayingClaim(claim)
    setPayingClaimId(claim.id)
    setPaymentForm({
      ...blankPaymentForm,
      paidAmount: claim.outstanding.toFixed(2),
    })
  }

  const handleRecordPayment = async (e) => {
    e.preventDefault()
    if (!payingClaim) return
    try {
      setSavingPayment(true)
      setError('')
      await recordClaimPayment({
        claimId:          payingClaimId,
        insurerName:      payingClaim.insurance_provider,
        approvedAmount:   Number(payingClaim.total_amount),
        paidAmount:       Number(paymentForm.paidAmount),
        paymentDate:      paymentForm.paymentDate,
        paymentMethod:    paymentForm.paymentMethod,
        paymentReference: paymentForm.paymentReference,
        notes:            paymentForm.notes,
        branchId:         branchFilter !== 'all' ? branchFilter : null,
        createdBy:        user?.id,
      })
      notify('Payment recorded.', 'success')
      setPayingClaimId(null)
      setPayingClaim(null)
      setPaymentForm(blankPaymentForm)
      void loadReceivables()
    } catch (err) {
      setError(err.message || 'Failed to record payment.')
    } finally {
      setSavingPayment(false)
    }
  }

  // â”€â”€ derived â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const expenseTotal = useMemo(
    () => expenses.filter((e) => e.status === 'posted').reduce((sum, e) => sum + Number(e.amount), 0),
    [expenses]
  )

  // â”€â”€ render helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const renderOverview = () => (
    <div className="acc-overview">
      {!overview ? (
        <p className="acc-empty">No data available for the selected period.</p>
      ) : (
        <>
          <div className="acc-kpi-grid">
            <div className="acc-kpi primary">
              <span className="acc-kpi-label">Revenue</span>
              <span className="acc-kpi-value">{fmt(overview.sales.revenue)}</span>
              <span className="acc-kpi-sub">{overview.sales.count} transactions</span>
            </div>
            <div className="acc-kpi danger">
              <span className="acc-kpi-label">Total Expenses</span>
              <span className="acc-kpi-value">{fmt(overview.expenses.totalExpenses)}</span>
            </div>
            <div className={`acc-kpi ${overview.grossProfit >= 0 ? 'success' : 'danger'}`}>
              <span className="acc-kpi-label">Gross Profit</span>
              <span className="acc-kpi-value">{fmt(overview.grossProfit)}</span>
              <span className="acc-kpi-sub">{overview.grossMarginPct.toFixed(1)}% margin</span>
            </div>
            <div className={`acc-kpi ${overview.netOperatingProfit >= 0 ? 'success' : 'danger'}`}>
              <span className="acc-kpi-label">Net Operating Profit</span>
              <span className="acc-kpi-value">{fmt(overview.netOperatingProfit)}</span>
            </div>
            <div className="acc-kpi warning">
              <span className="acc-kpi-label">Outstanding Receivables</span>
              <span className="acc-kpi-value">{fmt(overview.receivables.totalOutstanding)}</span>
              <span className="acc-kpi-sub">{overview.receivables.count} unpaid claims</span>
            </div>
            <div className={`acc-kpi ${overview.cashbook.totalVariance < 0 ? 'danger' : 'info'}`}>
              <span className="acc-kpi-label">Cash Variance (period)</span>
              <span className="acc-kpi-value">{fmt(overview.cashbook.totalVariance)}</span>
              <span className="acc-kpi-sub">{overview.cashbook.shortages} shortage{overview.cashbook.shortages !== 1 ? 's' : ''}</span>
            </div>
          </div>

          <div className="acc-overview-panels">
            <div className="acc-panel">
              <h3>Revenue by Payment Method</h3>
              {Object.entries(overview.sales.byMethod).length === 0
                ? <p className="acc-empty-sm">No sales data.</p>
                : Object.entries(overview.sales.byMethod)
                    .sort(([,a],[,b]) => b - a)
                    .map(([method, amount]) => (
                      <div className="acc-bar-row" key={method}>
                        <span className="acc-bar-label">{method}</span>
                        <div className="acc-bar-track">
                          <div
                            className="acc-bar-fill primary"
                            style={{ width: `${overview.sales.revenue > 0 ? (amount/overview.sales.revenue)*100 : 0}%` }}
                          />
                        </div>
                        <span className="acc-bar-value">{fmt(amount)}</span>
                      </div>
                    ))
              }
            </div>

            <div className="acc-panel">
              <h3>Expenses by Category</h3>
              {Object.entries(overview.expenses.byCategory).length === 0
                ? <p className="acc-empty-sm">No expense data.</p>
                : Object.entries(overview.expenses.byCategory)
                    .sort(([,a],[,b]) => b - a)
                    .map(([cat, amount]) => (
                      <div className="acc-bar-row" key={cat}>
                        <span className="acc-bar-label">{cat}</span>
                        <div className="acc-bar-track">
                          <div
                            className="acc-bar-fill danger"
                            style={{ width: `${overview.expenses.totalExpenses > 0 ? (amount/overview.expenses.totalExpenses)*100 : 0}%` }}
                          />
                        </div>
                        <span className="acc-bar-value">{fmt(amount)}</span>
                      </div>
                    ))
              }
            </div>

            {overview.receivables.byInsurer.length > 0 && (
              <div className="acc-panel">
                <h3>Receivables by Insurer</h3>
                {overview.receivables.byInsurer.map((ins) => (
                  <div className="acc-bar-row" key={ins.insurer}>
                    <span className="acc-bar-label">{ins.insurer}</span>
                    <div className="acc-bar-track">
                      <div
                        className="acc-bar-fill warning"
                        style={{ width: `${overview.receivables.totalOutstanding > 0 ? (ins.outstanding/overview.receivables.totalOutstanding)*100 : 0}%` }}
                      />
                    </div>
                    <span className="acc-bar-value">{fmt(ins.outstanding)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )

  const renderExpenses = () => (
    <div className="acc-expenses">
      <div className="acc-tab-toolbar">
        <div className="acc-summary-pill">
          Total posted: <strong>{fmt(expenseTotal)}</strong>
        </div>
        <div className="acc-toolbar-actions">
          <button className="btn btn-outline btn-sm" onClick={exportExpensesCsv} disabled={!expenses.length}>
            <Download size={15} /> Export CSV
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowExpenseForm((v) => !v)}>
            {showExpenseForm ? <X size={15} /> : <Plus size={15} />}
            {showExpenseForm ? 'Cancel' : 'New Expense'}
          </button>
        </div>
      </div>

      {showExpenseForm && (
        <form className="acc-form" onSubmit={handleCreateExpense}>
          <h4>Record Expense</h4>
          <div className="acc-form-grid">
            <label>
              Date
              <input type="date" value={expenseForm.expenseDate}
                onChange={(e) => setExpenseForm({ ...expenseForm, expenseDate: e.target.value })} />
            </label>
            <label>
              Category
              <select value={expenseForm.categoryId}
                onChange={(e) => setExpenseForm({ ...expenseForm, categoryId: e.target.value })}>
                <option value="">Select category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="full">
              Description *
              <input type="text" placeholder="Brief description"
                value={expenseForm.description}
                onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} />
            </label>
            <label>
              Amount (GHS) *
              <input type="number" min="0.01" step="0.01" placeholder="0.00"
                value={expenseForm.amount}
                onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} />
            </label>
            <label>
              Payment Method
              <select value={expenseForm.paymentMethod}
                onChange={(e) => setExpenseForm({ ...expenseForm, paymentMethod: e.target.value })}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_',' ')}</option>)}
              </select>
            </label>
            <label>
              Vendor / Payee
              <input type="text" placeholder="Optional"
                value={expenseForm.vendorName}
                onChange={(e) => setExpenseForm({ ...expenseForm, vendorName: e.target.value })} />
            </label>
            <label>
              Reference No.
              <input type="text" placeholder="Invoice / receipt number"
                value={expenseForm.referenceNumber}
                onChange={(e) => setExpenseForm({ ...expenseForm, referenceNumber: e.target.value })} />
            </label>
            <label className="full">
              Notes
              <textarea rows={2} placeholder="Optional notes"
                value={expenseForm.notes}
                onChange={(e) => setExpenseForm({ ...expenseForm, notes: e.target.value })} />
            </label>
          </div>
          <div className="acc-form-actions">
            <button type="submit" className="btn btn-primary" disabled={savingExpense}>
              {savingExpense ? 'Saving...' : 'Save Expense'}
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setShowExpenseForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!expenses.length && !loading && (
        <p className="acc-empty">No expenses found for the selected period.</p>
      )}

      {expenses.length > 0 && (
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Description</th>
                <th>Vendor</th>
                <th>Amount (GHS)</th>
                <th>Method</th>
                <th>Branch</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp) => (
                <tr key={exp.id} className={exp.status === 'cancelled' ? 'cancelled-row' : ''}>
                  <td>{exp.expense_date}</td>
                  <td>{exp.expense_categories?.name || '--'}</td>
                  <td>{exp.description}</td>
                  <td>{exp.vendor_name || '--'}</td>
                  <td className="amount-cell">{Number(exp.amount).toFixed(2)}</td>
                  <td>{exp.payment_method.replace('_',' ')}</td>
                  <td>{exp.branches?.name || '--'}</td>
                  <td>
                    <span className={`acc-badge acc-badge-${exp.status}`}>{exp.status}</span>
                  </td>
                  <td>
                    {exp.status === 'posted' && (
                      <button className="btn-icon-sm" title="Cancel expense"
                        onClick={() => handleCancelExpense(exp.id)}>
                        <X size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  const renderCashbook = () => {
    const currentSession = todaySession || sessions.find((s) => s.business_date === today)

    return (
      <div className="acc-cashbook">
        {branchFilter === 'all' && (
          <div className="acc-info-banner">
            <AlertTriangle size={16} />
            Select a specific branch to open or manage today's cashbook session.
          </div>
        )}

        {branchFilter !== 'all' && (
          <div className="acc-session-card">
            <h4>
              Today's Session
              {currentSession && (
                <span className={`acc-badge acc-badge-${currentSession.status}`}>
                  {currentSession.status}
                </span>
              )}
            </h4>

            {!currentSession && (
              <form className="acc-form acc-session-form" onSubmit={handleOpenSession}>
                <h5>Open Session</h5>
                <div className="acc-form-grid">
                  <label>
                    Opening Cash (GHS)
                    <input type="number" min="0" step="0.01" placeholder="0.00"
                      value={openingCash}
                      onChange={(e) => setOpeningCash(e.target.value)} />
                  </label>
                </div>
                <button type="submit" className="btn btn-primary" disabled={openingSession}>
                  {openingSession ? 'Opening...' : 'Open Cashbook'}
                </button>
              </form>
            )}

            {currentSession && currentSession.status === 'open' && (
              <>
                <div className="acc-session-stats">
                  <div className="acc-session-stat">
                    <span>Opening</span>
                    <strong>{fmt(currentSession.opening_cash)}</strong>
                  </div>
                  <div className="acc-session-stat">
                    <span>Expected</span>
                    <strong>{fmt(currentSession.expected_cash)}</strong>
                  </div>
                  {currentSession.counted_cash !== null && (
                    <div className="acc-session-stat">
                      <span>Variance</span>
                      <strong className={Number(currentSession.cash_variance) < 0 ? 'text-danger' : 'text-success'}>
                        {fmt(currentSession.cash_variance)}
                      </strong>
                    </div>
                  )}
                </div>

                <div className="acc-entries-list">
                  <h5>Entries</h5>
                  {(currentSession.cashbook_entries || []).length === 0 && (
                    <p className="acc-empty-sm">No entries yet.</p>
                  )}
                  {(currentSession.cashbook_entries || []).map((entry) => (
                    <div key={entry.id} className={`acc-entry-row ${entry.direction}`}>
                      <span className="acc-entry-type">{entry.entry_type.replace('_',' ')}</span>
                      <span className="acc-entry-desc">{entry.description || '--'}</span>
                      <span className="acc-entry-amount">
                        {entry.direction === 'in' ? '+' : '-'} {Number(entry.amount).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="acc-entry-form">
                  <h5>Manual Entry / Adjustment</h5>
                  <form onSubmit={handleAddEntry}>
                    <div className="acc-form-grid">
                      <label>
                        Amount (GHS) *
                        <input type="number" min="0.01" step="0.01" placeholder="0.00"
                          value={adjAmount}
                          onChange={(e) => setAdjAmount(e.target.value)} />
                      </label>
                      <label>
                        Direction
                        <select value={adjDirection} onChange={(e) => setAdjDirection(e.target.value)}>
                          <option value="in">In (receipt)</option>
                          <option value="out">Out (payment)</option>
                        </select>
                      </label>
                      <label className="full">
                        Description
                        <input type="text" placeholder="e.g. Bank deposit, petty cash"
                          value={adjDesc}
                          onChange={(e) => setAdjDesc(e.target.value)} />
                      </label>
                    </div>
                    <button type="submit" className="btn btn-outline btn-sm" disabled={addingEntry}>
                      {addingEntry ? 'Adding...' : 'Add Entry'}
                    </button>
                  </form>
                </div>

                <div className="acc-close-form">
                  <h5>Close Day</h5>
                  <form onSubmit={handleCloseSession}>
                    <div className="acc-form-grid">
                      <label>
                        Counted Cash (GHS) *
                        <input type="number" min="0" step="0.01" placeholder="Physical count"
                          value={countedCash}
                          onChange={(e) => setCountedCash(e.target.value)} />
                      </label>
                      <label className="full">
                        Notes
                        <input type="text" placeholder="Optional notes"
                          value={sessionNotes}
                          onChange={(e) => setSessionNotes(e.target.value)} />
                      </label>
                    </div>
                    <button type="submit" className="btn btn-danger btn-sm" disabled={closingSession}>
                      {closingSession ? 'Closing...' : 'Close Session'}
                    </button>
                  </form>
                </div>
              </>
            )}

            {currentSession && currentSession.status === 'closed' && (
              <div className="acc-session-stats">
                <div className="acc-session-stat">
                  <span>Opening</span>
                  <strong>{fmt(currentSession.opening_cash)}</strong>
                </div>
                <div className="acc-session-stat">
                  <span>Expected</span>
                  <strong>{fmt(currentSession.expected_cash)}</strong>
                </div>
                <div className="acc-session-stat">
                  <span>Counted</span>
                  <strong>{fmt(currentSession.counted_cash)}</strong>
                </div>
                <div className="acc-session-stat">
                  <span>Variance</span>
                  <strong className={Number(currentSession.cash_variance) < 0 ? 'text-danger' : 'text-success'}>
                    {fmt(currentSession.cash_variance)}
                  </strong>
                </div>
              </div>
            )}
          </div>
        )}

        {sessions.length > 0 && (
          <div className="acc-table-wrap">
            <h4>Session History</h4>
            <table className="acc-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Branch</th>
                  <th>Opening</th>
                  <th>Expected</th>
                  <th>Counted</th>
                  <th>Variance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.business_date}</td>
                    <td>{s.branches?.name || '--'}</td>
                    <td className="amount-cell">{Number(s.opening_cash).toFixed(2)}</td>
                    <td className="amount-cell">{Number(s.expected_cash).toFixed(2)}</td>
                    <td className="amount-cell">{s.counted_cash !== null ? Number(s.counted_cash).toFixed(2) : '--'}</td>
                    <td className={`amount-cell ${Number(s.cash_variance) < 0 ? 'text-danger' : Number(s.cash_variance) > 0 ? 'text-success' : ''}`}>
                      {s.cash_variance !== null ? Number(s.cash_variance).toFixed(2) : '--'}
                    </td>
                    <td><span className={`acc-badge acc-badge-${s.status}`}>{s.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  const renderReceivables = () => (
    <div className="acc-receivables">
      {receivablesSummary && (
        <div className="acc-kpi-grid receivables-kpis">
          <div className="acc-kpi warning">
            <span className="acc-kpi-label">Outstanding</span>
            <span className="acc-kpi-value">{fmt(receivablesSummary.totalOutstanding)}</span>
            <span className="acc-kpi-sub">{receivablesSummary.count} claims</span>
          </div>
          <div className="acc-kpi success">
            <span className="acc-kpi-label">Total Paid</span>
            <span className="acc-kpi-value">{fmt(receivablesSummary.totalPaid)}</span>
          </div>
          <div className="acc-kpi info">
            <span className="acc-kpi-label">Total Approved</span>
            <span className="acc-kpi-value">{fmt(receivablesSummary.totalApproved)}</span>
          </div>
        </div>
      )}

      {receivablesSummary && receivablesSummary.count > 0 && (
        <div className="acc-aging">
          <h4>Receivables Aging</h4>
          <div className="acc-aging-grid">
            {['0-30','31-60','61-90','90+'].map((bucket) => (
              <div key={bucket} className={`acc-aging-bucket${bucket === '90+' ? ' overdue' : ''}`}>
                <span className="aging-days">{bucket} days</span>
                <span className="aging-amount">{fmt(receivablesSummary.byAgeBucket[bucket] || 0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {receivables.length === 0 && !loading && (
        <p className="acc-empty">No outstanding receivables. All approved claims are fully paid.</p>
      )}

      {receivables.length > 0 && (
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead>
              <tr>
                <th>Claim No.</th>
                <th>Patient</th>
                <th>Insurer</th>
                <th>Service Date</th>
                <th>Approved (GHS)</th>
                <th>Paid (GHS)</th>
                <th>Outstanding (GHS)</th>
                <th>Age</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {receivables.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.claim_number}</code></td>
                  <td>{r.patient_name}</td>
                  <td>{r.insurance_provider}</td>
                  <td>{r.service_date}</td>
                  <td className="amount-cell">{Number(r.approved_amount).toFixed(2)}</td>
                  <td className="amount-cell">{r.totalPaid.toFixed(2)}</td>
                  <td className="amount-cell text-danger">{r.outstanding.toFixed(2)}</td>
                  <td>
                    <span className={`acc-badge ${r.ageBucket === '90+' ? 'acc-badge-danger' : r.ageBucket === '61-90' ? 'acc-badge-warning' : 'acc-badge-info'}`}>
                      {r.ageDays}d
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-primary btn-sm"
                      onClick={() => openPaymentModal(r)}>
                      Record Payment
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {payingClaim && (
        <div className="acc-modal-backdrop" onClick={() => { setPayingClaimId(null); setPayingClaim(null) }}>
          <div className="acc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="acc-modal-header">
              <h4>Record Payment - {payingClaim.claim_number}</h4>
              <button type="button" className="btn-icon-sm" onClick={() => { setPayingClaimId(null); setPayingClaim(null) }}>
                <X size={16} />
              </button>
            </div>
            <p className="acc-modal-subtitle">
              Insurer: <strong>{payingClaim.insurance_provider}</strong> &nbsp;|&nbsp; Outstanding: <strong>{fmt(payingClaim.outstanding)}</strong>
            </p>
            <form onSubmit={handleRecordPayment}>
              <div className="acc-form-grid">
                <label>
                  Amount Paid (GHS) *
                  <input type="number" min="0.01" step="0.01"
                    value={paymentForm.paidAmount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paidAmount: e.target.value })} />
                </label>
                <label>
                  Payment Date
                  <input type="date" value={paymentForm.paymentDate}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })} />
                </label>
                <label>
                  Payment Method
                  <select value={paymentForm.paymentMethod}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentMethod: e.target.value })}>
                    {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_',' ')}</option>)}
                  </select>
                </label>
                <label>
                  Reference No.
                  <input type="text" placeholder="e.g. NHIS-2026-04123"
                    value={paymentForm.paymentReference}
                    onChange={(e) => setPaymentForm({ ...paymentForm, paymentReference: e.target.value })} />
                </label>
                <label className="full">
                  Notes
                  <textarea rows={2}
                    value={paymentForm.notes}
                    onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
                </label>
              </div>
              {error && <p className="acc-form-error">{error}</p>}
              <div className="acc-form-actions">
                <button type="submit" className="btn btn-primary" disabled={savingPayment}>
                  {savingPayment ? 'Saving...' : 'Save Payment'}
                </button>
                <button type="button" className="btn btn-outline"
                  onClick={() => { setPayingClaimId(null); setPayingClaim(null) }}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )

  // â”€â”€ main render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  return (
    <div className="accounting-page">
      <div className="page-header">
        <div>
          <h1>Accounting</h1>
          <p>Financial overview, expenses, cashbook, and insurance receivables</p>
        </div>
        <div className="acc-header-controls">
          <div className="date-range">
            <Calendar size={16} />
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <span>to</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          {branches.length > 0 && (
            <select className="acc-branch-select"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}>
              <option value="all">All Branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <button className="btn btn-primary" onClick={refresh} disabled={loading}>
            <RefreshCcw size={15} />
            {loading ? 'Loading...' : 'Generate'}
          </button>
        </div>
      </div>

      {error && <div className="acc-alert">{error}</div>}
      {!error && activeTab === 'overview' && overviewWarning && (
        <div className="acc-info-banner">
          <AlertTriangle size={16} />
          {overviewWarning}
        </div>
      )}

      <div className="acc-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`acc-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="acc-tab-content">
        {loading && <p className="acc-loading">Loading...</p>}
        {!loading && activeTab === 'overview'    && renderOverview()}
        {!loading && activeTab === 'expenses'    && renderExpenses()}
        {!loading && activeTab === 'cashbook'    && renderCashbook()}
        {!loading && activeTab === 'receivables' && renderReceivables()}
      </div>
    </div>
  )
}

export default Accounting
