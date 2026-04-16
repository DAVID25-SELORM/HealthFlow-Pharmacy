import { supabase } from '../lib/supabase'
import { formatLocalDate } from '../utils/date'
import { assertNonNegativeNumber, assertRequiredText, normalizeText } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'
import { recordCashbookMovementIfSessionOpen } from './cashbookService'

export const getExpenseCategories = async () => {
  const { data, error } = await supabase
    .from('expense_categories')
    .select('*')
    .eq('is_active', true)
    .order('name')

  if (error) throw error
  return data
}

export const createExpenseCategory = async ({ name, code }) => {
  const { data, error } = await supabase
    .from('expense_categories')
    .insert([
      {
        name: assertRequiredText(name, 'Category name'),
        code: assertRequiredText(code, 'Category code').toUpperCase(),
      },
    ])
    .select()
    .single()

  if (error) throw error
  return data
}

export const deactivateExpenseCategory = async (id) => {
  const { error } = await supabase
    .from('expense_categories')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) throw error
}

export const getExpenses = async (filters = {}) => {
  let query = supabase
    .from('expenses')
    .select(`
      *,
      expense_categories (id, name, code),
      branches (id, name, code)
    `)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (filters.startDate) query = query.gte('expense_date', filters.startDate)
  if (filters.endDate) query = query.lte('expense_date', filters.endDate)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.branchId) query = query.eq('branch_id', filters.branchId)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.paymentMethod) query = query.eq('payment_method', filters.paymentMethod)

  const { data, error } = await query
  if (error) throw error
  return data
}

export const createExpense = async (expenseData) => {
  const payload = {
    expense_date: expenseData.expenseDate || formatLocalDate(),
    description: assertRequiredText(expenseData.description, 'Description'),
    amount: assertNonNegativeNumber(expenseData.amount, 'Amount'),
    payment_method: expenseData.paymentMethod || 'cash',
    vendor_name: normalizeText(expenseData.vendorName) || null,
    reference_number: normalizeText(expenseData.referenceNumber) || null,
    receipt_url: normalizeText(expenseData.receiptUrl) || null,
    notes: normalizeText(expenseData.notes) || null,
    status: expenseData.status || 'posted',
    category_id: expenseData.categoryId || null,
    branch_id: expenseData.branchId || null,
    created_by: expenseData.createdBy || null,
  }

  const { data, error } = await supabase
    .from('expenses')
    .insert([payload])
    .select('*, expense_categories(id,name,code), branches(id,name,code)')
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'expense.created',
    entityType: 'expenses',
    entityId: data.id,
    action: 'create',
    details: { amount: data.amount, description: data.description, status: data.status },
  })

  if (data.status === 'posted' && data.payment_method === 'cash' && data.branch_id) {
    try {
      await recordCashbookMovementIfSessionOpen({
        branchId: data.branch_id,
        entryType: 'expense_cash',
        sourceType: 'expense',
        sourceId: data.id,
        amount: data.amount,
        direction: 'out',
        description: data.description,
        createdBy: data.created_by,
      })
    } catch (cashbookError) {
      console.warn('Unable to sync expense to cashbook:', cashbookError)
    }
  }

  return data
}

export const updateExpense = async (id, updates) => {
  const payload = { updated_at: new Date().toISOString() }

  if (updates.expenseDate) payload.expense_date = updates.expenseDate
  if (updates.description) payload.description = assertRequiredText(updates.description, 'Description')
  if (updates.amount !== undefined) payload.amount = assertNonNegativeNumber(updates.amount, 'Amount')
  if (updates.paymentMethod) payload.payment_method = updates.paymentMethod
  if (updates.vendorName !== undefined) payload.vendor_name = normalizeText(updates.vendorName) || null
  if (updates.referenceNumber !== undefined) payload.reference_number = normalizeText(updates.referenceNumber) || null
  if (updates.receiptUrl !== undefined) payload.receipt_url = normalizeText(updates.receiptUrl) || null
  if (updates.notes !== undefined) payload.notes = normalizeText(updates.notes) || null
  if (updates.status) payload.status = updates.status
  if (updates.categoryId !== undefined) payload.category_id = updates.categoryId || null
  if (updates.branchId !== undefined) payload.branch_id = updates.branchId || null

  const { data, error } = await supabase
    .from('expenses')
    .update(payload)
    .eq('id', id)
    .select('*, expense_categories(id,name,code), branches(id,name,code)')
    .single()

  if (error) throw error
  return data
}

export const cancelExpense = async (id) => {
  const { data: existing, error: fetchError } = await supabase
    .from('expenses')
    .select('id, amount, description, status, payment_method, branch_id, created_by')
    .eq('id', id)
    .single()

  if (fetchError) throw fetchError

  const updatedExpense = await updateExpense(id, { status: 'cancelled' })

  if (existing.status === 'posted' && existing.payment_method === 'cash' && existing.branch_id) {
    try {
      await recordCashbookMovementIfSessionOpen({
        branchId: existing.branch_id,
        entryType: 'adjustment',
        sourceType: 'expense',
        sourceId: existing.id,
        amount: existing.amount,
        direction: 'in',
        description: `Expense cancellation ${existing.description}`,
        createdBy: existing.created_by,
      })
    } catch (cashbookError) {
      console.warn('Unable to sync expense cancellation to cashbook:', cashbookError)
    }
  }

  return updatedExpense
}

export const getExpenseSummary = async (startDate, endDate, branchId = null) => {
  let query = supabase
    .from('expenses')
    .select('category_id, expense_categories(name,code), amount, payment_method, branch_id')
    .eq('status', 'posted')
    .gte('expense_date', startDate)
    .lte('expense_date', endDate)

  if (branchId) query = query.eq('branch_id', branchId)

  const { data, error } = await query
  if (error) throw error

  const totalExpenses = data.reduce((sum, row) => sum + Number(row.amount), 0)

  const byCategory = data.reduce((acc, row) => {
    const key = row.expense_categories?.name || 'Uncategorised'
    acc[key] = (acc[key] || 0) + Number(row.amount)
    return acc
  }, {})

  const byPaymentMethod = data.reduce((acc, row) => {
    acc[row.payment_method] = (acc[row.payment_method] || 0) + Number(row.amount)
    return acc
  }, {})

  return { totalExpenses, byCategory, byPaymentMethod, rows: data }
}
