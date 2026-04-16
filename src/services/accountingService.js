import { supabase } from '../lib/supabase'
import { getUserBranchIdsByUserIds } from './branchService'
import { getExpenseSummary } from './expenseService'
import { getReceivablesSummary } from './receivablesService'
import { getCashbookSummary } from './cashbookService'

const defaultSalesSummary = () => ({ revenue: 0, cogs: 0, byMethod: {}, count: 0 })
const defaultExpenseSummary = () => ({ totalExpenses: 0, byCategory: {}, byPaymentMethod: {}, rows: [] })
const defaultReceivablesSummary = () => ({
  totalOutstanding: 0,
  totalApproved: 0,
  totalPaid: 0,
  byInsurer: [],
  byAgeBucket: {},
  count: 0,
})
const defaultCashbookSummary = () => ({ sessions: [], totalVariance: 0, surpluses: 0, shortages: 0 })

const unwrapSettled = (result, fallback, label, warnings) => {
  if (result.status === 'fulfilled') {
    return result.value
  }

  warnings.push(label)
  return fallback()
}

const filterRowsByUserBranch = async (rows, userIdField, branchId) => {
  if (!branchId) {
    return rows
  }

  const branchMap = await getUserBranchIdsByUserIds(rows.map((row) => row[userIdField]))
  return rows.filter((row) => branchMap[row[userIdField]] === branchId)
}

export const getAccountingOverview = async (startDate, endDate, branchId = null) => {
  const warnings = []

  const [salesResult, expenseResult, receivablesResult, cashbookResult] = await Promise.allSettled([
    fetchSalesSummary(startDate, endDate, branchId),
    getExpenseSummary(startDate, endDate, branchId),
    getReceivablesSummary(branchId),
    getCashbookSummary(startDate, endDate, branchId),
  ])

  const sales = unwrapSettled(salesResult, defaultSalesSummary, 'sales', warnings)
  const expenses = unwrapSettled(expenseResult, defaultExpenseSummary, 'expenses', warnings)
  const receivables = unwrapSettled(receivablesResult, defaultReceivablesSummary, 'receivables', warnings)
  const cashbook = unwrapSettled(cashbookResult, defaultCashbookSummary, 'cashbook', warnings)

  const grossProfit = sales.revenue - sales.cogs
  const grossMarginPct = sales.revenue > 0 ? (grossProfit / sales.revenue) * 100 : 0
  const netOperatingProfit = grossProfit - expenses.totalExpenses

  return {
    sales,
    expenses,
    receivables,
    cashbook,
    grossProfit,
    grossMarginPct,
    netOperatingProfit,
    warnings,
  }
}

const fetchSalesSummary = async (startDate, endDate, branchId) => {
  const { data, error } = await supabase
    .from('sales')
    .select(`
      net_amount,
      payment_method,
      sold_by,
      sale_items (
        quantity,
        unit_price,
        drug_id,
        drugs (cost_price)
      )
    `)
    .eq('payment_status', 'completed')
    .gte('sale_date', `${startDate}T00:00:00`)
    .lte('sale_date', `${endDate}T23:59:59`)

  if (error) throw error

  const scopedSales = await filterRowsByUserBranch(data || [], 'sold_by', branchId)

  const revenue = scopedSales.reduce((sum, sale) => sum + Number(sale.net_amount), 0)
  const cogs = scopedSales.reduce((sum, sale) => {
    const itemCogs = (sale.sale_items || []).reduce((itemSum, item) => {
      const cost = Number(item.drugs?.cost_price || 0)
      return itemSum + cost * Number(item.quantity)
    }, 0)

    return sum + itemCogs
  }, 0)

  const byMethod = scopedSales.reduce((acc, sale) => {
    acc[sale.payment_method] = (acc[sale.payment_method] || 0) + Number(sale.net_amount)
    return acc
  }, {})

  return { revenue, cogs, byMethod, count: scopedSales.length }
}

export const getBranchProfitAndLoss = async (startDate, endDate, branches = []) => {
  return Promise.all(
    branches.map(async (branch) => {
      const [salesResult, expenseResult] = await Promise.allSettled([
        fetchSalesSummary(startDate, endDate, branch.id),
        getExpenseSummary(startDate, endDate, branch.id),
      ])

      const sales = salesResult.status === 'fulfilled' ? salesResult.value : defaultSalesSummary()
      const expenses = expenseResult.status === 'fulfilled' ? expenseResult.value : defaultExpenseSummary()

      const grossProfit = sales.revenue - sales.cogs
      const netProfit = grossProfit - expenses.totalExpenses

      return {
        branchId: branch.id,
        branchName: branch.name,
        revenue: sales.revenue,
        cogs: sales.cogs,
        grossProfit,
        expenses: expenses.totalExpenses,
        netProfit,
      }
    })
  )
}
