import { supabase } from '../lib/supabase'
import { assertNonNegativeNumber, assertRequiredText, normalizeText } from '../utils/validation'
import { tryLogAuditEvent } from './auditService'

const SHIFT_SELECT = `
  *,
  branches (id, name, code),
  shift_cash_movements (*)
`

const attachShiftUsers = async (shifts) => {
  const rows = Array.isArray(shifts) ? shifts : shifts ? [shifts] : []
  if (rows.length === 0) return shifts

  const userIds = [
    ...new Set(
      rows
        .flatMap((shift) => [shift.opened_by, shift.closed_by])
        .filter(Boolean)
    ),
  ]

  if (userIds.length === 0) {
    return Array.isArray(shifts)
      ? rows.map((shift) => ({ ...shift, opener: null, closer: null }))
      : { ...rows[0], opener: null, closer: null }
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, email')
    .in('id', userIds)

  if (error) throw error

  const usersById = new Map((data || []).map((profile) => [profile.id, profile]))
  const hydrated = rows.map((shift) => ({
    ...shift,
    opener: usersById.get(shift.opened_by) || null,
    closer: usersById.get(shift.closed_by) || null,
  }))

  return Array.isArray(shifts) ? hydrated : hydrated[0]
}

export const getOpenShiftForUser = async (userId) => {
  if (!userId) {
    return null
  }

  const { data, error } = await supabase
    .from('shifts')
    .select(SHIFT_SELECT)
    .eq('opened_by', userId)
    .eq('status', 'open')
    .maybeSingle()

  if (error) {
    throw error
  }

  return data ? attachShiftUsers(data) : null
}

export const getShifts = async (filters = {}) => {
  let query = supabase
    .from('shifts')
    .select(SHIFT_SELECT)
    .order('opened_at', { ascending: false })

  if (filters.branchId) query = query.eq('branch_id', filters.branchId)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.userId) query = query.eq('opened_by', filters.userId)
  if (filters.startDate) query = query.gte('opened_at', `${filters.startDate}T00:00:00`)
  if (filters.endDate) query = query.lte('opened_at', `${filters.endDate}T23:59:59`)

  const { data, error } = await query
  if (error) throw error
  return attachShiftUsers(data || [])
}

export const openShift = async ({ organizationId, branchId, openingCash, openedBy }) => {
  const organization = assertRequiredText(organizationId, 'Organization')
  const branch = assertRequiredText(branchId, 'Branch')
  const opener = assertRequiredText(openedBy, 'Cashier')
  const opening = assertNonNegativeNumber(openingCash || 0, 'Opening cash')

  const { data, error } = await supabase
    .from('shifts')
    .insert([
      {
        organization_id: organization,
        branch_id: branch,
        opened_by: opener,
        opening_cash: opening,
        expected_cash: opening,
        status: 'open',
      },
    ])
    .select(SHIFT_SELECT)
    .single()

  if (error) {
    if (String(error.message || '').toLowerCase().includes('idx_shifts_one_open_per_user')) {
      throw new Error('You already have an open shift. Close it before opening another.')
    }
    throw error
  }

  if (opening > 0) {
    await addShiftMovement({
      shiftId: data.id,
      organizationId: organization,
      branchId: branch,
      movementType: 'opening_cash',
      sourceType: 'shift',
      sourceId: data.id,
      amount: opening,
      direction: 'in',
      description: 'Opening cash float',
      createdBy: opener,
      updateExpected: false,
    })
  }

  await tryLogAuditEvent({
    eventType: 'shift.opened',
    entityType: 'shifts',
    entityId: data.id,
    action: 'create',
    details: { branch_id: branch, opening_cash: opening },
  })

  return getOpenShiftForUser(opener)
}

export const closeShift = async ({ shiftId, countedCash, notes, closedBy }) => {
  const id = assertRequiredText(shiftId, 'Shift')
  const counted = assertNonNegativeNumber(countedCash, 'Counted cash')

  const { data: existing, error: existingError } = await supabase
    .from('shifts')
    .select('id, expected_cash, status')
    .eq('id', id)
    .single()

  if (existingError) throw existingError
  if (existing.status === 'closed') throw new Error('This shift is already closed.')

  const { data, error } = await supabase
    .from('shifts')
    .update({
      counted_cash: counted,
      notes: normalizeText(notes) || null,
      closed_by: closedBy || null,
      closed_at: new Date().toISOString(),
      status: 'closed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(SHIFT_SELECT)
    .single()

  if (error) throw error

  await tryLogAuditEvent({
    eventType: 'shift.closed',
    entityType: 'shifts',
    entityId: id,
    action: 'update',
    details: {
      counted_cash: counted,
      expected_cash: existing.expected_cash,
      variance: counted - Number(existing.expected_cash || 0),
    },
  })

  return attachShiftUsers(data)
}

export const addShiftMovement = async ({
  shiftId,
  organizationId,
  branchId,
  movementType,
  sourceType,
  sourceId,
  amount,
  direction,
  description,
  createdBy,
  updateExpected = true,
}) => {
  const numericAmount = assertNonNegativeNumber(amount, 'Amount')
  const signedDelta = direction === 'out' ? -numericAmount : numericAmount

  const { data, error } = await supabase
    .from('shift_cash_movements')
    .insert([
      {
        shift_id: assertRequiredText(shiftId, 'Shift'),
        organization_id: assertRequiredText(organizationId, 'Organization'),
        branch_id: assertRequiredText(branchId, 'Branch'),
        movement_type: movementType,
        source_type: sourceType || 'manual',
        source_id: sourceId || null,
        amount: numericAmount,
        direction,
        description: normalizeText(description) || null,
        created_by: createdBy || null,
      },
    ])
    .select()
    .single()

  if (error) throw error

  if (updateExpected) {
    const { error: updateError } = await supabase.rpc('increment_shift_expected', {
      p_shift_id: shiftId,
      p_delta: signedDelta,
    })

    if (updateError) throw updateError
  }

  return data
}
