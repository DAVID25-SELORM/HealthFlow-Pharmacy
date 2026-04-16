import { supabase } from '../lib/supabase'
import { getExpenseSummary }        from './expenseService'
import { getReceivablesSummary }    from './receivablesService'
import { getCashbookSummary }       from './cashbookService'

/**
 * Pull all data needed for the Accounting Overview dashboard in one call.
 */
export const getAccountingOverview = async (startDate, endDate, branchId = null) => {
  const [salesResult, expenseResult, receivablesResult, cashbookResult] =
    await Promise.allSettled([
      fetchSalesSummary(startDate, endDate, branchId),
      getExpenseSummary(startDate, endDate, branchId),
      getReceivablesSummary(),
      getCashbookSummary(startDate, endDate, branchId),
    ])

  const sales       = salesResult.status       === 'fulfilled' ? salesResult.value       : defaultSalesSummary()
  const expenses    = expenseResult.status      === 'fulfilled' ? expenseResult.value      : defaultExpenseSummary()
  const receivables = receivablesResult.status  === 'fulfilled' ? receivablesResult.value  : defaultReceivablesSummary()
  const cashbook    = cashbookResult.status     === 'fulfilled' ? cashbookResult.value     : defaultCashbookSummary()

  const grossProfit      = sales.revenue - sales.cogs
  const grossMarginPct   = sales.revenue > 0 ? (grossProfit / sales.revenue) * 100 : 0
  const netOperatingProfit = grossProfit - expenses.totalExpenses

  return {
    sales,
    expenses,
    receivables,
    cashbook,
    grossProfit,
    grossMarginPct,
    netOperatingProfit,
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const fetchSalesSummary = async (startDate, endDate, branchId) => {
  let query = supabase
    .from('sales')
    .select(`
      net_amount,
      total_amount,
      payment_method,
      sale_items (quantity, unit_price, drug_id,
        drugs (cost_price)
      )
    `)
    .eq('payment_status', 'completed')
    .gte('sale_date', `${startDate}T00:00:00`)
    .lte('sale_date', `${endDate}T23:59:59`)

  if (branchId) query = query.eq('branch_id', branchId)

  const { data, error } = await query
  if (error) throw error

  const revenue = data.reduce((sum, s) => sum + Number(s.net_amount), 0)
  const cogs    = data.reduce((sum, s) => {
    const itemCogs = (s.sale_items || []).reduce((iSum, item) => {
      const cost = Number(item.drugs?.cost_price || 0)
      return iSum + cost * Number(item.quantity)
    }, 0)
    return sum + itemCogs
  }, 0)

  const byMethod = data.reduce((acc, s) => {
    acc[s.payment_method] = (acc[s.payment_method] || 0) + Number(s.net_amount)
    return acc
  }, {})

  return { revenue, cogs, byMethod, count: data.length }
}

const defaultSalesSummary      = () => ({ revenue: 0, cogs: 0, byMethod: {}, count: 0 })
const defaultExpenseSummary    = () => ({ totalExpenses: 0, byCategory: {}, byPaymentMethod: {}, rows: [] })
const defaultReceivablesSummary = () => ({ totalOutstanding: 0, totalApproved: 0, totalPaid: 0, byInsurer: [], byAgeBucket: {}, count: 0 })
const defaultCashbookSummary   = () => ({ sessions: [], totalVariance: 0, surpluses: 0, shortages: 0 })

// ── Branch P&L ────────────────────────────────────────────────────────────────

export const getBranchProfitAndLoss = async (startDate, endDate, branches = []) => {
  return Promise.all(
    branches.map(async (branch) => {
      const [salesResult, expenseResult] = await Promise.allSettled([
        fetchSalesSummary(startDate, endDate, branch.id),
        getExpenseSummary(startDate, endDate, branch.id),
      ])

      const sales    = salesResult.status    === 'fulfilled' ? salesResult.value    : defaultSalesSummary()
      const expenses = expenseResult.status  === 'fulfilled' ? expenseResult.value  : defaultExpenseSummary()

      const grossProfit = sales.revenue - sales.cogs
      const netProfit   = grossProfit - expenses.totalExpenses

      return {
        branchId:   branch.id,
        branchName: branch.name,
        revenue:    sales.revenue,
        cogs:       sales.cogs,
        grossProfit,
        expenses:   expenses.totalExpenses,
        netProfit,
      }
    })
  )
}
