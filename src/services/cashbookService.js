import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

// ── Sessions ──────────────────────────────────────────────────────────────────

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

  if (filters.branchId)  query = query.eq('branch_id', filters.branchId)
  if (filters.status)    query = query.eq('status', filters.status)
  if (filters.startDate) query = query.gte('business_date', filters.startDate)
  if (filters.endDate)   query = query.lte('business_date', filters.endDate)

  const { data, error } = await query
  if (error) throw error
  return data
}

export const getTodaySession = async (branchId) => {
  const today = new Date().toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('cashbook_sessions')
    .select(`
      *,
      branches (id, name, code),
      cashbook_entries (*)
    `)
    .eq('branch_id', branchId)
    .eq('business_date', today)
    .maybeSingle()

  if (error) throw error
  return data
}

export const openCashbookSession = async ({ branchId, openingCash, openedBy }) => {
  const today = new Date().toISOString().split('T')[0]

  // Check for existing open session
  const { data: existing } = await supabase
    .from('cashbook_sessions')
    .select('id, status')
    .eq('branch_id', branchId)
    .eq('business_date', today)
    .maybeSingle()

  if (existing) {
    throw new Error('A cashbook session for today already exists for this branch.')
  }

  const opening = assertNonNegativeNumber(openingCash, 'Opening cash')

  const { data, error } = await supabase
    .from('cashbook_sessions')
    .insert([{
      branch_id:    branchId,
      business_date: today,
      opening_cash: opening,
      expected_cash: opening,
      status:       'open',
      opened_by:    openedBy || null,
    }])
    .select()
    .single()

  if (error) throw error

  // Record opening balance as first entry
  if (opening > 0) {
    await addCashbookEntry({
      sessionId:   data.id,
      branchId,
      entryType:  'adjustment',
      sourceType: 'manual',
      amount:      opening,
      direction:  'in',
      description: 'Opening balance',
      createdBy:   openedBy || null,
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

  // Get current expected
  const { data: session, error: fetchErr } = await supabase
    .from('cashbook_sessions')
    .select('id, expected_cash, status')
    .eq('id', sessionId)
    .single()

  if (fetchErr) throw fetchErr
  if (session.status === 'closed') throw new Error('This session is already closed.')

  const { data, error } = await supabase
    .from('cashbook_sessions')
    .update({
      counted_cash: counted,
      notes:        notes || null,
      status:       'closed',
      closed_by:    closedBy || null,
      closed_at:    new Date().toISOString(),
      updated_at:   new Date().toISOString(),
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
      counted_cash:  counted,
      expected_cash: session.expected_cash,
      variance:      counted - Number(session.expected_cash),
    },
  })

  return data
}

// ── Entries ───────────────────────────────────────────────────────────────────

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
  const organizationId = await getOrgIdForSession(sessionId)

  const { data, error } = await supabase
    .from('cashbook_entries')
    .insert([{
      session_id:      sessionId,
      organization_id: organizationId,
      branch_id:       branchId,
      entry_type:      entryType,
      source_type:     sourceType || null,
      source_id:       sourceId  || null,
      amount:          assertNonNegativeNumber(amount, 'Amount'),
      direction,
      description:     description || null,
      created_by:      createdBy  || null,
    }])
    .select()
    .single()

  if (error) throw error

  // Update expected_cash on the session
  const delta = direction === 'in' ? Number(amount) : -Number(amount)
  await supabase.rpc('increment_cashbook_expected', {
    p_session_id: sessionId,
    p_delta: delta,
  }).then(({ error: rpcErr }) => {
    if (rpcErr) {
      // Fallback: manual update if RPC not available
      return supabase
        .from('cashbook_sessions')
        .select('expected_cash')
        .eq('id', sessionId)
        .single()
        .then(({ data: sess }) =>
          supabase
            .from('cashbook_sessions')
            .update({
              expected_cash: Math.max(0, Number(sess.expected_cash) + delta),
              updated_at: new Date().toISOString(),
            })
            .eq('id', sessionId)
        )
    }
  })

  return data
}

const getOrgIdForSession = async (sessionId) => {
  const { data, error } = await supabase
    .from('cashbook_sessions')
    .select('organization_id')
    .eq('id', sessionId)
    .single()
  if (error) throw error
  return data.organization_id
}

// ── Reconciliation summary ────────────────────────────────────────────────────

export const getCashbookSummary = async (startDate, endDate, branchId = null) => {
  let query = supabase
    .from('cashbook_sessions')
    .select('opening_cash, expected_cash, counted_cash, cash_variance, status, business_date, branches(id,name)')
    .gte('business_date', startDate)
    .lte('business_date', endDate)

  if (branchId) query = query.eq('branch_id', branchId)

  const { data, error } = await query
  if (error) throw error

  const closed   = data.filter((s) => s.status === 'closed')
  const variance = closed.reduce((sum, s) => sum + Number(s.cash_variance || 0), 0)
  const surpluses = closed.filter((s) => Number(s.cash_variance) > 0).length
  const shortages = closed.filter((s) => Number(s.cash_variance) < 0).length

  return { sessions: data, totalVariance: variance, surpluses, shortages }
}
