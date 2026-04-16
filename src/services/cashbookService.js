import { supabase } from '../lib/supabase'
import { formatLocalDate } from '../utils/date'
import { assertNonNegativeNumber } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

export const getCashbookSessions = async (filters = {}) => {
  let query = supabase
    .from('cashbook_sessions')
    .select(`
      *,
      branches (id, name, code),
      cashbook_entries (id, entry_type, direction, amount, description, source_type, created_at)
    `)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (filters.branchId) query = query.eq('branch_id', filters.branchId)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.startDate) query = query.gte('business_date', filters.startDate)
  if (filters.endDate) query = query.lte('business_date', filters.endDate)

  const { data, error } = await query
  if (error) throw error
  return data
}

export const getTodaySession = async (branchId, businessDate = formatLocalDate()) => {
  const { data, error } = await supabase
    .from('cashbook_sessions')
    .select(`
      *,
      branches (id, name, code),
      cashbook_entries (*)
    `)
    .eq('branch_id', branchId)
    .eq('business_date', businessDate)
    .maybeSingle()

  if (error) throw error
  return data
}

export const getOpenCashbookSessionForBranch = async (branchId, businessDate = formatLocalDate()) => {
  const { data, error } = await supabase
    .from('cashbook_sessions')
    .select('id, organization_id, branch_id, business_date, status')
    .eq('branch_id', branchId)
    .eq('business_date', businessDate)
    .eq('status', 'open')
    .maybeSingle()

  if (error) throw error
  return data
}

export const openCashbookSession = async ({ branchId, openingCash, openedBy }) => {
  const today = formatLocalDate()

  const { data: existing, error: existingError } = await supabase
    .from('cashbook_sessions')
    .select('id, status')
    .eq('branch_id', branchId)
    .eq('business_date', today)
    .maybeSingle()

  if (existingError) throw existingError
  if (existing) {
    throw new Error('A cashbook session for today already exists for this branch.')
  }

  const opening = assertNonNegativeNumber(openingCash, 'Opening cash')

  const { data, error } = await supabase
    .from('cashbook_sessions')
    .insert([
      {
        branch_id: branchId,
        business_date: today,
        opening_cash: opening,
        expected_cash: 0,
        status: 'open',
        opened_by: openedBy || null,
      },
    ])
    .select()
    .single()

  if (error) throw error

  if (opening > 0) {
    await addCashbookEntry({
      sessionId: data.id,
      branchId,
      entryType: 'adjustment',
      sourceType: 'manual',
      amount: opening,
      direction: 'in',
      description: 'Opening balance',
      createdBy: openedBy || null,
    })
  }

  await tryLogAuditEvent({
    eventType: 'cashbook.opened',
    entityType: 'cashbook_sessions',
    entityId: data.id,
    action: 'create',
    details: { branch_id: branchId, opening_cash: opening, date: today },
  })

  return data
}

export const closeCashbookSession = async ({ sessionId, countedCash, notes, closedBy }) => {
  const counted = assertNonNegativeNumber(countedCash, 'Counted cash')

  const { data: session, error: fetchError } = await supabase
    .from('cashbook_sessions')
    .select('id, expected_cash, status')
    .eq('id', sessionId)
    .single()

  if (fetchError) throw fetchError
  if (session.status === 'closed') throw new Error('This session is already closed.')

  const { data, error } = await supabase
    .from('cashbook_sessions')
    .update({
      counted_cash: counted,
      notes: notes || null,
      status: 'closed',
      closed_by: closedBy || null,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .select()
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'cashbook.closed',
    entityType: 'cashbook_sessions',
    entityId: sessionId,
    action: 'update',
    details: {
      counted_cash: counted,
      expected_cash: session.expected_cash,
      variance: counted - Number(session.expected_cash),
    },
  })

  return data
}

export const addCashbookEntry = async ({
  sessionId,
  branchId,
  entryType,
  sourceType,
  sourceId,
  amount,
  direction,
  description,
  createdBy,
}) => {
  const numericAmount = assertNonNegativeNumber(amount, 'Amount')

  const { data, error } = await supabase
    .from('cashbook_entries')
    .insert([
      {
        session_id: sessionId,
        branch_id: branchId,
        entry_type: entryType,
        source_type: sourceType || null,
        source_id: sourceId || null,
        amount: numericAmount,
        direction,
        description: description || null,
        created_by: createdBy || null,
      },
    ])
    .select()
    .single()

  if (error) throw error

  const delta = direction === 'in' ? numericAmount : -numericAmount
  await syncSessionExpectedCash(sessionId, delta)

  return data
}

export const recordCashbookMovementIfSessionOpen = async ({
  branchId,
  entryType,
  sourceType,
  sourceId,
  amount,
  direction,
  description,
  createdBy,
}) => {
  const numericAmount = Number(amount)
  if (!branchId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    return null
  }

  const session = await getOpenCashbookSessionForBranch(branchId)
  if (!session) {
    return null
  }

  return addCashbookEntry({
    sessionId: session.id,
    branchId,
    entryType,
    sourceType,
    sourceId,
    amount: numericAmount,
    direction,
    description,
    createdBy,
  })
}

const syncSessionExpectedCash = async (sessionId, delta) => {
  const { error: rpcError } = await supabase.rpc('increment_cashbook_expected', {
    p_session_id: sessionId,
    p_delta: delta,
  })

  if (!rpcError) {
    return
  }

  const { data: session, error: sessionError } = await supabase
    .from('cashbook_sessions')
    .select('expected_cash')
    .eq('id', sessionId)
    .single()

  if (sessionError) throw sessionError

  const { error: updateError } = await supabase
    .from('cashbook_sessions')
    .update({
      expected_cash: Math.max(0, Number(session.expected_cash) + delta),
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)

  if (updateError) throw updateError
}

export const getCashbookSummary = async (startDate, endDate, branchId = null) => {
  let query = supabase
    .from('cashbook_sessions')
    .select('opening_cash, expected_cash, counted_cash, cash_variance, status, business_date, branches(id,name)')
    .gte('business_date', startDate)
    .lte('business_date', endDate)

  if (branchId) query = query.eq('branch_id', branchId)

  const { data, error } = await query
  if (error) throw error

  const closed = data.filter((session) => session.status === 'closed')
  const variance = closed.reduce((sum, session) => sum + Number(session.cash_variance || 0), 0)
  const surpluses = closed.filter((session) => Number(session.cash_variance) > 0).length
  const shortages = closed.filter((session) => Number(session.cash_variance) < 0).length

  return { sessions: data, totalVariance: variance, surpluses, shortages }
}
