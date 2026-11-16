import { supabase } from '../lib/supabase'
import { canSendFromBranch } from './branchTransferService'

// Stock requests between branches (migration 20261117090000, BRANCH-003).
// Inventory staff at a branch ask another branch (normally the main store) for medicines. An administrator,
// or staff of the branch being asked, approves (possibly lowering or dropping lines) or declines. Approving
// dispatches an ordinary confirmed transfer, so the receiving branch still confirms what arrived.
// The database functions enforce who may do what; the helpers below only decide which buttons to show.

export const REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
}

export const REQUEST_STATUS_LABELS = {
  pending: 'Waiting',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Cancelled',
}

const MAX_LINES = 100
const QUANTITY_PATTERN = /^[0-9]{1,8}(\.[0-9]{1,2})?$/

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const num = (value) => Number.parseFloat(value) || 0

const callRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message || 'The request could not be completed.')
  if (data?.error) throw new Error(data.error)
  return data
}

export const searchBranchStockForRequest = async ({ sourceBranchId, term, limit = 12 }) => {
  const source = text(sourceBranchId)
  const query = text(term)
  if (!source || query.length < 2) return []
  const data = await callRpc('search_branch_stock_for_request', {
    p_source_branch_id: source,
    p_term: query,
    p_limit: limit,
  })
  return Array.isArray(data) ? data : []
}

export const createBranchStockRequest = async ({ sourceBranchId, requestingBranchId, items, notes = '' }) => {
  const source = text(sourceBranchId)
  const requesting = text(requestingBranchId)
  if (!source) throw new Error('Choose the branch you are asking for stock.')
  if (!requesting) throw new Error('Choose the branch that needs the stock.')
  if (source === requesting) throw new Error('Choose two different branches.')
  if (!Array.isArray(items) || items.length === 0) throw new Error('Add at least one medicine.')
  if (items.length > MAX_LINES) throw new Error(`A request can carry at most ${MAX_LINES} medicines.`)

  const payload = items.map((item, index) => {
    const drugId = text(item?.drugId)
    if (!drugId) throw new Error(`Line ${index + 1}: choose a medicine.`)
    const quantity = String(item?.quantity ?? '').trim()
    if (!QUANTITY_PATTERN.test(quantity) || Number.parseFloat(quantity) <= 0) {
      throw new Error(`Line ${index + 1}: quantity must be above zero, with at most 2 decimals.`)
    }
    return { drug_id: drugId, quantity }
  })

  return callRpc('create_branch_stock_request', {
    p_source_branch_id: source,
    p_requesting_branch_id: requesting,
    p_items: payload,
    p_notes: text(notes) || null,
  })
}

// `lines` is [{ itemId, quantityApproved }] covering every line (0 drops a line), or null to approve all as asked.
export const approveBranchStockRequest = async ({ requestId, lines = null, notes = '' }) => {
  const id = text(requestId)
  if (!id) throw new Error('Choose a request.')
  const payload = lines === null
    ? null
    : lines.map((line, index) => {
      const quantity = String(line?.quantityApproved ?? '').trim()
      if (!QUANTITY_PATTERN.test(quantity)) {
        throw new Error(`Line ${index + 1}: approved quantity must be zero or more, with at most 2 decimals.`)
      }
      return { item_id: text(line?.itemId), quantity_approved: quantity }
    })
  return callRpc('approve_branch_stock_request', {
    p_request_id: id,
    p_items: payload,
    p_notes: text(notes) || null,
  })
}

const resolveWithReason = (rpcName) => async ({ requestId, reason }) => {
  const id = text(requestId)
  const why = text(reason)
  if (!id) throw new Error('Choose a request.')
  if (why.length < 5) throw new Error('Enter a reason of at least 5 characters.')
  return callRpc(rpcName, { p_request_id: id, p_reason: why })
}

export const declineBranchStockRequest = resolveWithReason('decline_branch_stock_request')
export const cancelBranchStockRequest = resolveWithReason('cancel_branch_stock_request')

const REQUEST_SELECT = '*, items:branch_stock_request_items(*)'

const loadStaffNames = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const { data, error } = await supabase.from('users').select('id, full_name').in('id', unique)
  if (error) return new Map() // names are a convenience; the request is still usable without them
  return new Map((data || []).map((row) => [row.id, row.full_name || '']))
}

export const listBranchStockRequests = async ({ limit = 200 } = {}) => {
  const { data, error } = await supabase
    .from('branch_stock_requests')
    .select(REQUEST_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message || 'Unable to load stock requests.')
  const rows = data || []
  const names = await loadStaffNames(rows.flatMap((row) => [row.created_by, row.resolved_by]))
  return rows.map((row) => ({
    ...row,
    items: [...(row.items || [])].sort((a, b) => String(a.medicine_name).localeCompare(String(b.medicine_name))),
    created_by_name: names.get(row.created_by) || '',
    resolved_by_name: names.get(row.resolved_by) || '',
  }))
}

// ---- pure helpers -------------------------------------------------------------------------

export const summarizeRequest = (request) => {
  const items = request?.items || []
  return {
    lines: items.length,
    totalRequested: items.reduce((sum, item) => sum + num(item.quantity_requested), 0),
    totalApproved: request?.status === REQUEST_STATUS.APPROVED
      ? items.reduce((sum, item) => sum + num(item.quantity_approved), 0)
      : 0,
  }
}

// The people who can send from the asked branch decide: an administrator, that branch's staff, or staff with no branch.
export const canDecideRequest = (actor, request) =>
  request?.status === REQUEST_STATUS.PENDING && canSendFromBranch(actor, request.source_branch_id)

export const canCancelRequest = (actor, request) =>
  request?.status === REQUEST_STATUS.PENDING
  && (request.created_by === actor.userId
    || actor.isAdmin
    || (actor.isManager && (!actor.branchId || actor.branchId === request.requesting_branch_id)))

export const requestNeedsMyAction = (actor, request) => canDecideRequest(actor, request)

// What is waiting for this person, as two counts for the notification bell: requests they can decide
// (the same people who can send from the asked branch) and transfers they can confirm (a manager of the
// receiving branch, an administrator, or a manager with no branch). Counts only; any failure gives zeros
// so the bell never breaks (for example if the request tables are not there yet).
export const countStockWork = async (actor) => {
  const none = { requestsToDecide: 0, transfersToConfirm: 0 }
  if (!actor) return none
  try {
    const decidesAnywhere = actor.isAdmin || !actor.branchId
    let requests = supabase.from('branch_stock_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    if (!decidesAnywhere) requests = requests.eq('source_branch_id', actor.branchId)

    const confirmsAnywhere = actor.isAdmin || (actor.isManager && !actor.branchId)
    const confirmsOwn = actor.isManager && Boolean(actor.branchId)
    let transfers = null
    if (confirmsAnywhere || confirmsOwn) {
      transfers = supabase.from('branch_stock_transfers').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      if (!confirmsAnywhere) transfers = transfers.eq('destination_branch_id', actor.branchId)
    }

    const [requestResult, transferResult] = await Promise.all([requests, transfers])
    return {
      requestsToDecide: requestResult?.error ? 0 : requestResult?.count || 0,
      transfersToConfirm: transferResult?.error ? 0 : transferResult?.count || 0,
    }
  } catch {
    return none
  }
}

// Branch-bound staff who are not administrators ask for stock; everyone else simply sends a transfer.
export const canAskForStock = (actor) => Boolean(actor?.branchId) && !actor.isAdmin
