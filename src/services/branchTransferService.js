import { supabase } from '../lib/supabase'

// Confirmed branch-to-branch stock transfers (migration 20261111090000).
// A sender dispatches; stock leaves the source branch at once. The receiving branch then confirms
// what arrived (anything short goes back to the sender), rejects the lot, or the sender cancels
// while it is still pending. The database functions enforce who may do what; the helpers below only
// decide which buttons to show.

export const TRANSFER_STATUS = {
  PENDING: 'pending',
  RECEIVED: 'received',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
}

export const TRANSFER_STATUS_LABELS = {
  pending: 'In transit',
  received: 'Received',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
}

const MAX_LINES = 100
const QUANTITY_PATTERN = /^[0-9]{1,8}(\.[0-9]{1,2})?$/

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const num = (value) => Number.parseFloat(value) || 0

const parseQuantity = (value, label) => {
  const normalized = String(value ?? '').trim()
  if (!QUANTITY_PATTERN.test(normalized) || Number.parseFloat(normalized) <= 0) {
    throw new Error(`${label} must be above zero, with at most 2 decimals.`)
  }
  return normalized
}

const parseReceivedQuantity = (value, label) => {
  const normalized = String(value ?? '').trim()
  if (!QUANTITY_PATTERN.test(normalized)) {
    throw new Error(`${label} must be zero or more, with at most 2 decimals.`)
  }
  return normalized
}

const callRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message || 'The transfer could not be completed.')
  if (data?.error) throw new Error(data.error)
  return data
}

export const dispatchBranchTransfer = async ({
  sourceBranchId,
  destinationBranchId,
  items,
  notes = '',
}) => {
  const source = text(sourceBranchId)
  const destination = text(destinationBranchId)
  if (!source) throw new Error('Choose the branch the stock is leaving.')
  if (!destination) throw new Error('Choose the branch the stock is going to.')
  if (source === destination) throw new Error('Choose two different branches.')
  if (!Array.isArray(items) || items.length === 0) throw new Error('Add at least one medicine.')
  if (items.length > MAX_LINES) throw new Error(`A transfer can carry at most ${MAX_LINES} medicines.`)

  const payload = items.map((item, index) => {
    const drugId = text(item?.drugId)
    if (!drugId) throw new Error(`Line ${index + 1}: choose a medicine.`)
    return { drug_id: drugId, quantity: parseQuantity(item?.quantity, `Line ${index + 1}: quantity`) }
  })

  return callRpc('create_branch_stock_transfer', {
    p_source_branch_id: source,
    p_destination_branch_id: destination,
    p_items: payload,
    p_notes: text(notes) || null,
  })
}

// `lines` is [{ itemId, quantityReceived }] covering every line, or null to accept everything.
export const receiveBranchTransfer = async ({ transferId, lines = null, notes = '' }) => {
  const id = text(transferId)
  if (!id) throw new Error('Choose a transfer.')
  const payload = lines === null
    ? null
    : lines.map((line, index) => ({
      item_id: text(line?.itemId),
      quantity_received: parseReceivedQuantity(line?.quantityReceived, `Line ${index + 1}: received quantity`),
    }))
  return callRpc('receive_branch_stock_transfer', {
    p_transfer_id: id,
    p_items: payload,
    p_notes: text(notes) || null,
  })
}

const resolveWithReason = (rpcName) => async ({ transferId, reason }) => {
  const id = text(transferId)
  const why = text(reason)
  if (!id) throw new Error('Choose a transfer.')
  if (why.length < 5) throw new Error('Enter a reason of at least 5 characters.')
  return callRpc(rpcName, { p_transfer_id: id, p_reason: why })
}

export const rejectBranchTransfer = resolveWithReason('reject_branch_stock_transfer')
export const cancelBranchTransfer = resolveWithReason('cancel_branch_stock_transfer')

const TRANSFER_SELECT = '*, items:branch_stock_transfer_items(*)'

const loadStaffNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const { data, error } = await supabase.from('users').select('id, full_name').in('id', unique)
  if (error) return new Map() // names are a convenience; the transfer is still usable without them
  return new Map((data || []).map((row) => [row.id, row.full_name || '']))
}

const withStaffNames = async (transfers) => {
  const names = await loadStaffNames(transfers.flatMap((row) => [row.created_by, row.resolved_by]))
  return transfers.map((row) => ({
    ...row,
    items: [...(row.items || [])].sort((a, b) => String(a.medicine_name).localeCompare(String(b.medicine_name))),
    created_by_name: names.get(row.created_by) || '',
    resolved_by_name: names.get(row.resolved_by) || '',
  }))
}

export const listBranchTransfers = async ({ limit = 200 } = {}) => {
  const { data, error } = await supabase
    .from('branch_stock_transfers')
    .select(TRANSFER_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message || 'Unable to load transfers.')
  return withStaffNames(data || [])
}

export const getBranchTransfer = async (transferId) => {
  const { data, error } = await supabase
    .from('branch_stock_transfers')
    .select(TRANSFER_SELECT)
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(error.message || 'Unable to load the transfer.')
  if (!data) return null
  const [row] = await withStaffNames([data])
  return row
}

// ---- pure helpers -------------------------------------------------------------------------

export const summarizeTransfer = (transfer) => {
  const items = transfer?.items || []
  const totalSent = items.reduce((sum, item) => sum + num(item.quantity_sent), 0)
  const settled = transfer?.status === TRANSFER_STATUS.RECEIVED
  const totalReceived = settled ? items.reduce((sum, item) => sum + num(item.quantity_received), 0) : 0
  return {
    lines: items.length,
    totalSent,
    totalReceived,
    shortfall: settled ? totalSent - totalReceived : 0,
    hasDiscrepancy: settled && items.some((item) => num(item.quantity_received) < num(item.quantity_sent)),
  }
}

// The caller's role and branch, as the database sees them. `assignedRoles` are extra roles.
export const describeActor = ({ role, assignedRoles, profile } = {}) => {
  const roles = new Set([role, ...(assignedRoles || [])].filter(Boolean))
  return {
    userId: profile?.id || null,
    branchId: profile?.branch_id || null,
    isAdmin: roles.has('admin'),
    isManager: roles.has('branch_manager'),
  }
}

const managesBranch = (actor, branchId) =>
  actor.isAdmin || (actor.isManager && (!actor.branchId || actor.branchId === branchId))

export const canReceiveTransfer = (actor, transfer) =>
  transfer?.status === TRANSFER_STATUS.PENDING && managesBranch(actor, transfer.destination_branch_id)

export const canCancelTransfer = (actor, transfer) =>
  transfer?.status === TRANSFER_STATUS.PENDING
  && (transfer.created_by === actor.userId || managesBranch(actor, transfer.source_branch_id))

// Staff tied to one branch can only send from it; administrators and org-level staff can send from any.
export const canSendFromBranch = (actor, branchId) =>
  actor.isAdmin || !actor.branchId || actor.branchId === branchId

export const needsMyAction = (actor, transfer) => canReceiveTransfer(actor, transfer)
