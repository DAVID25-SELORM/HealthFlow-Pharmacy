import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, toNumber } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import { getUserBranchIdsByUserIds } from './branchService'
import { recordCashbookMovementIfSessionOpen } from './cashbookService'
import { addShiftMovement } from './shiftService'

/**
 * Sales Service
 * Handles all sales/POS operations
 */

const VALID_PAYMENT_METHODS = ['cash', 'momo', 'insurance', 'card']
const VALID_PATIENT_TOP_UP_METHODS = ['cash', 'momo', 'card']
const assertPositiveSaleQuantity = (value, label) => {
  const parsed = assertNonNegativeNumber(value, label)
  if (parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`)
  }

  return parsed
}

const normalizePaymentMethod = (value) => {
  const normalized = String(value || '').trim().toLowerCase()

  if (!VALID_PAYMENT_METHODS.includes(normalized)) {
    throw new Error(`Payment method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}.`)
  }

  return normalized
}

const normalizePatientTopUpMethod = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) {
    return null
  }

  if (!VALID_PATIENT_TOP_UP_METHODS.includes(normalized)) {
    throw new Error(`Patient top-up method must be one of: ${VALID_PATIENT_TOP_UP_METHODS.join(', ')}.`)
  }

  return normalized
}

const isSaleNumberDuplicateError = (error) => {
  const code = String(error?.code || '').toUpperCase()
  const message = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return code === '23505' && message.includes('sales_sale_number_key')
}

const buildValidatedSaleTotals = (saleData) => {
  const paymentMethod = normalizePaymentMethod(saleData.paymentMethod)
  const totalAmount = saleData.items.reduce((sum, item) => {
    const quantity = assertPositiveSaleQuantity(item.quantity, 'Item quantity')
    const price = assertNonNegativeNumber(item.price, 'Item price')
    return sum + (price * quantity)
  }, 0)

  const discount = assertNonNegativeNumber(saleData.discount ?? 0, 'Discount')
  if (discount > totalAmount) {
    throw new Error('Discount cannot exceed total amount.')
  }

  const netAmount = totalAmount - discount
  let amountPaid = toNumber(saleData.amountPaid ?? netAmount, netAmount)
  let change = paymentMethod === 'cash' ? toNumber(saleData.change ?? 0, 0) : 0

  if (paymentMethod === 'cash' && amountPaid < netAmount) {
    throw new Error('Amount paid cannot be less than the sale total for cash payments.')
  }

  if (change < 0) {
    throw new Error('Change cannot be negative.')
  }

  if (paymentMethod !== 'cash') {
    amountPaid = netAmount
    change = 0
  }

  return {
    totalAmount,
    discount,
    netAmount,
    amountPaid,
    change,
    paymentMethod,
  }
}

const resolveSaleBranchId = async (branchId, soldBy) => {
  if (branchId) {
    return branchId
  }

  if (!soldBy) {
    return null
  }

  const branchMap = await getUserBranchIdsByUserIds([soldBy])
  return branchMap[soldBy] || null
}

const syncCashSaleToCashbook = async ({
  saleId,
  saleNumber,
  paymentMethod,
  soldBy,
  branchId: saleBranchId,
  netAmount,
}) => {
  if (paymentMethod !== 'cash' || !soldBy || Number(netAmount) <= 0) {
    return
  }

  const branchId = await resolveSaleBranchId(saleBranchId, soldBy)
  if (!branchId) {
    return
  }

  try {
    await recordCashbookMovementIfSessionOpen({
      branchId,
      entryType: 'sale_cash',
      sourceType: 'sale',
      sourceId: saleId,
      amount: netAmount,
      direction: 'in',
      description: `Cash sale ${saleNumber}`,
      createdBy: soldBy,
    })
  } catch (cashbookError) {
    console.warn('Unable to sync cash sale to cashbook:', cashbookError)
  }
}

const syncInsuranceCashTopUpToCashbook = async ({
  saleId,
  saleNumber,
  topUpPaymentMethod,
  soldBy,
  branchId: saleBranchId,
  topUpAmount,
}) => {
  if (topUpPaymentMethod !== 'cash' || !soldBy || Number(topUpAmount) <= 0) {
    return
  }

  const branchId = await resolveSaleBranchId(saleBranchId, soldBy)
  if (!branchId) {
    return
  }

  try {
    await recordCashbookMovementIfSessionOpen({
      branchId,
      entryType: 'sale_cash',
      sourceType: 'sale',
      sourceId: saleId,
      amount: topUpAmount,
      direction: 'in',
      description: `Insurance cash top-up ${saleNumber}`,
      createdBy: soldBy,
    })
  } catch (cashbookError) {
    console.warn('Unable to sync insurance cash top-up to cashbook:', cashbookError)
  }
}

const syncInsuranceCashTopUpToShift = async ({
  shiftId,
  organizationId,
  branchId,
  saleId,
  saleNumber,
  topUpPaymentMethod,
  soldBy,
  topUpAmount,
}) => {
  if (
    topUpPaymentMethod !== 'cash' ||
    !shiftId ||
    !organizationId ||
    !branchId ||
    !soldBy ||
    Number(topUpAmount) <= 0
  ) {
    return
  }

  try {
    await addShiftMovement({
      shiftId,
      organizationId,
      branchId,
      movementType: 'sale_cash',
      sourceType: 'sale',
      sourceId: saleId,
      amount: topUpAmount,
      direction: 'in',
      description: `Insurance cash top-up ${saleNumber}`,
      createdBy: soldBy,
    })
  } catch (shiftError) {
    console.warn('Unable to sync insurance cash top-up to shift:', shiftError)
  }
}

// Create new sale
export const createSale = async (saleData) => {
  try {
    if (!saleData?.items?.length) {
      throw new Error('At least one sale item is required.')
    }

    if (!saleData.shiftId) {
      throw new Error('Open a shift before completing sales.')
    }

    const totals = buildValidatedSaleTotals(saleData)
    const insuranceCoveredAmount = assertNonNegativeNumber(
      saleData.insuranceCoveredAmount ?? 0,
      'Insurance covered amount'
    )
    const insuranceTopUpAmount = assertNonNegativeNumber(
      saleData.insuranceTopUpAmount ?? 0,
      'Insurance top-up amount'
    )
    const insuranceTopUpPaymentMethod = normalizePatientTopUpMethod(
      saleData.insuranceTopUpPaymentMethod
    )

    const { data: txData, error: txError } = await supabase.rpc('create_sale_transaction', {
      sale_payload: {
        patient_id: saleData.patientId || null,
        payment_method: totals.paymentMethod,
        payment_status: 'completed',
        amount_paid: totals.amountPaid,
        change_given: totals.change,
        notes: saleData.notes || null,
        sold_by: saleData.soldBy || null,
        sale_date: saleData.saleDate || new Date().toISOString(),
        discount: totals.discount,
        shift_id: saleData.shiftId,
        insurance_covered_amount: insuranceCoveredAmount,
        insurance_top_up_amount: insuranceTopUpAmount,
        insurance_top_up_payment_method: insuranceTopUpPaymentMethod,
        items: saleData.items.map((item) => ({
          drugId: item.drugId,
          name: item.name,
          quantity: assertPositiveSaleQuantity(item.quantity, 'Item quantity'),
          price: assertNonNegativeNumber(item.price, 'Item price'),
        })),
      },
    })

    if (txError) {
      if (isSaleNumberDuplicateError(txError)) {
        throw new Error('Sale number conflict. Please try completing the sale again.')
      }

      throw txError
    }

    const txPayload = txData || {}

    await tryLogAuditEvent({
      eventType: 'sale.completed',
      entityType: 'sales',
      entityId: txPayload.sale_id,
      action: 'create',
      details: {
        sale_number: txPayload.sale_number,
        item_count: saleData.items.length,
        total_amount: totals.netAmount,
        payment_method: totals.paymentMethod,
      },
    })

    await syncCashSaleToCashbook({
      saleId: txPayload.sale_id,
      saleNumber: txPayload.sale_number,
      paymentMethod: totals.paymentMethod,
      soldBy: saleData.soldBy,
      branchId: saleData.branchId || txPayload.branch_id,
      netAmount: totals.netAmount,
    })

    await syncInsuranceCashTopUpToCashbook({
      saleId: txPayload.sale_id,
      saleNumber: txPayload.sale_number,
      topUpPaymentMethod: insuranceTopUpPaymentMethod,
      soldBy: saleData.soldBy,
      branchId: saleData.branchId || txPayload.branch_id,
      topUpAmount: insuranceTopUpAmount,
    })

    await syncInsuranceCashTopUpToShift({
      shiftId: saleData.shiftId,
      organizationId: saleData.organizationId,
      branchId: saleData.branchId,
      saleId: txPayload.sale_id,
      saleNumber: txPayload.sale_number,
      topUpPaymentMethod: insuranceTopUpPaymentMethod,
      soldBy: saleData.soldBy,
      topUpAmount: insuranceTopUpAmount,
    })

    return {
      sale: {
        id: txPayload.sale_id,
        sale_number: txPayload.sale_number,
      },
      saleNumber: txPayload.sale_number,
    }
  } catch (error) {
    console.error('Error creating sale:', error)
    throw error
  }
}

// Refund an existing sale and restore stock quantities
export const refundSale = async ({ saleId, reason, role, canRefund = false }) => {
  const normalizedRole = String(role || '').trim().toLowerCase()
  if (normalizedRole !== 'admin' && !canRefund) {
    throw new Error('Only admins or staff granted refund permission can process refunds.')
  }

  if (!saleId) {
    throw new Error('Sale ID is required.')
  }

  const { data, error } = await supabase.rpc('refund_sale_transaction', {
    p_sale_id: saleId,
    p_reason: reason || null,
  })

  if (error) {
    throw error
  }

  await tryLogAuditEvent({
    eventType: 'sale.refunded',
    entityType: 'sales',
    entityId: data?.sale_id || saleId,
    action: 'refund',
    details: {
      sale_number: data?.sale_number || null,
      reason: reason || null,
    },
  })

  const cashRefundAmount = Number(data?.refund_cash_amount || 0)
  if (cashRefundAmount > 0 && data?.branch_id) {
    try {
      await recordCashbookMovementIfSessionOpen({
        branchId: data.branch_id,
        entryType: 'refund_cash',
        sourceType: 'refund',
        sourceId: data?.sale_id || saleId,
        amount: cashRefundAmount,
        direction: 'out',
        description: `Cash refund ${data?.sale_number || ''}`.trim(),
        createdBy: data?.refunded_by || null,
      })
    } catch (cashbookError) {
      console.warn('Unable to sync cash refund to cashbook:', cashbookError)
    }
  }

  return data
}

// Get all sales
export const getAllSales = async (filters = {}) => {
  let query = supabase
    .from('sales')
    .select(`
      *,
      sale_items (
        *,
        drugs (name)
      ),
      patients (full_name)
    `)
    .order('sale_date', { ascending: false })
  
  // Apply filters
  if (filters.startDate) {
    query = query.gte('sale_date', filters.startDate)
  }
  
  if (filters.endDate) {
    query = query.lte('sale_date', filters.endDate)
  }
  
  if (filters.paymentMethod) {
    query = query.eq('payment_method', filters.paymentMethod)
  }
  
  if (filters.paymentStatus) {
    query = query.eq('payment_status', filters.paymentStatus)
  }
  
  const { data, error } = await query
  
  if (error) throw error
  return data
}

// Get sale by ID
export const getSaleById = async (id) => {
  const { data, error } = await supabase
    .from('sales')
    .select(`
      *,
      sale_items (*),
      patients (*),
      users:sold_by (full_name)
    `)
    .eq('id', id)
    .single()
  
  if (error) throw error
  return data
}

// Get daily sales summary
export const getDailySalesSummary = async (date = new Date()) => {
  const dateStr = date.toISOString().split('T')[0]
  
  const { data, error } = await supabase
    .from('daily_sales_summary')
    .select('*')
    .eq('sale_date', dateStr)
    .single()
  
  if (error && error.code !== 'PGRST116') throw error
  
  return data || {
    sale_date: dateStr,
    total_sales: 0,
    total_revenue: 0,
    cash_sales: 0,
    momo_sales: 0,
    insurance_sales: 0
  }
}

// Get today's sales
export const getTodaysSales = async () => {
  const today = new Date().toISOString().split('T')[0]
  
  const { data, error } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .gte('sale_date', `${today}T00:00:00`)
    .lte('sale_date', `${today}T23:59:59`)
    .eq('payment_status', 'completed')
    .order('sale_date', { ascending: false })
  
  if (error) throw error
  return data
}

// Get recent sales
export const getRecentSales = async (limit = 10) => {
  const { data, error } = await supabase
    .from('sales')
    .select(`
      *,
      patients (full_name)
    `)
    .eq('payment_status', 'completed')
    .order('sale_date', { ascending: false })
    .limit(limit)
  
  if (error) throw error
  return data
}

// Get sales analytics
export const getSalesAnalytics = async (startDate, endDate) => {
  const { data, error } = await supabase
    .from('sales')
    .select('*')
    .gte('sale_date', startDate)
    .lte('sale_date', endDate)
    .eq('payment_status', 'completed')
  
  if (error) throw error
  
  // Calculate analytics
  const totalSales = data.length
  const totalRevenue = data.reduce((sum, sale) => sum + parseFloat(sale.net_amount), 0)
  const avgSaleValue = totalSales > 0 ? totalRevenue / totalSales : 0
  
  const byCash = data.filter(s => s.payment_method === 'cash')
  const byMomo = data.filter(s => s.payment_method === 'momo')
  const byInsurance = data.filter(s => s.payment_method === 'insurance')
  
  return {
    totalSales,
    totalRevenue,
    avgSaleValue,
    cashSales: byCash.length,
    cashRevenue: byCash.reduce((sum, s) => sum + parseFloat(s.net_amount), 0),
    momoSales: byMomo.length,
    momoRevenue: byMomo.reduce((sum, s) => sum + parseFloat(s.net_amount), 0),
    insuranceSales: byInsurance.length,
    insuranceRevenue: byInsurance.reduce((sum, s) => sum + parseFloat(s.net_amount), 0)
  }
}
