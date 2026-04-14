import { supabase } from '../lib/supabase'

/**
 * Sales Service
 * Handles all sales/POS operations
 */

// Generate sale number
const generateSaleNumber = async () => {
  const { data, error } = await supabase.rpc('generate_sale_number')
  
  if (error) {
    // Fallback if function doesn't exist
    const timestamp = Date.now()
    return `SAL-${timestamp.toString().slice(-8)}`
  }
  
  return data
}

// Create new sale
export const createSale = async (saleData) => {
  try {
    // Generate sale number
    const saleNumber = await generateSaleNumber()
    
    // Calculate totals
    const totalAmount = saleData.items.reduce(
      (sum, item) => sum + (item.price * item.quantity), 
      0
    )
    const discount = parseFloat(saleData.discount || 0)
    const netAmount = totalAmount - discount
    
    // Create sale record
    const { data: sale, error: saleError } = await supabase
      .from('sales')
      .insert([
        {
          sale_number: saleNumber,
          patient_id: saleData.patientId || null,
          total_amount: totalAmount,
          discount: discount,
          net_amount: netAmount,
          payment_method: saleData.paymentMethod,
          payment_status: 'completed',
          amount_paid: parseFloat(saleData.amountPaid || netAmount),
          change_given: parseFloat(saleData.change || 0),
          notes: saleData.notes,
          sold_by: saleData.soldBy,
          sale_date: new Date().toISOString()
        }
      ])
      .select()
    
    if (saleError) throw saleError
    
    // Create sale items
    const saleItems = saleData.items.map(item => ({
      sale_id: sale[0].id,
      drug_id: item.drugId,
      drug_name: item.name,
      quantity: parseFloat(item.quantity),
      unit_price: parseFloat(item.price),
      total_price: parseFloat(item.price * item.quantity)
    }))
    
    const { error: itemsError } = await supabase
      .from('sale_items')
      .insert(saleItems)
    
    if (itemsError) throw itemsError
    
    return { sale: sale[0], saleNumber }
  } catch (error) {
    console.error('Error creating sale:', error)
    throw error
  }
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
