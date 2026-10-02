import { supabase } from '../lib/supabase'
import { listBranchRecords, shouldUseBranchServer } from './branchServerApi'
import {
  classifyNhisCccDuplicateSignals,
  isBlockingNhisCccDuplicateSignal,
  nhisDuplicateMemberKey,
  isVoidedNhisClaim,
} from '../utils/nhisCccDuplicate'

// The RPC normalizes stored values, applies facility/RLS scope, and pages all
// candidates. A popular CCC must not hide a true duplicate beyond a row limit.
export const assertNoDuplicateNhisClaimInStore = async (candidate) => {
  const { ignoreClaimId = '', onCccDuplicateSignal, useBranchServer } = candidate
  if (isVoidedNhisClaim(candidate.status)) return
  const ccc = String(candidate.cccNo || '').replace(/\D/g, '')
  const member = nhisDuplicateMemberKey(candidate)
  if (!ccc && !member && !candidate.patientId) return
  let rows = []
  if (useBranchServer || shouldUseBranchServer()) {
    rows = await listBranchRecords('nhis/claims', { limit: 100000 })
    if (!Array.isArray(rows) || rows.length >= 100000) {
      throw new Error('Unable to complete duplicate review. Refresh the facility claims before saving.')
    }
  } else {
    const pageSize = 200
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase.rpc('get_nhis_ccc_duplicate_candidates', {
        p_member: member || null,
        p_patient_id: candidate.patientId || null,
        p_ccc: ccc || null,
        p_service_date: candidate.serviceDate || null,
        p_ignore_id: ignoreClaimId || null,
        p_offset: offset,
        p_limit: pageSize,
      })
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < pageSize) break
    }
  }
  const signals = classifyNhisCccDuplicateSignals({ ...candidate, id: ignoreClaimId, ccc }, rows)
  const blocking = signals.find(isBlockingNhisCccDuplicateSignal)
  if (blocking) {
    // A review callback can show the existing claim, but cannot authorize bypass.
    if (onCccDuplicateSignal) await onCccDuplicateSignal(signals)
    throw Object.assign(new Error(blocking.message), {
      code: 'NHIS_CCC_DUPLICATE', duplicateClaim: blocking.claim, signals,
    })
  }
  if (!signals.length) return
  const needsReview = signals.some((signal) => signal.severity !== 'info')
  const reviewed = onCccDuplicateSignal ? await onCccDuplicateSignal(signals) : false
  if (needsReview && reviewed !== true) {
    throw Object.assign(new Error('Review the existing claim before continuing.'), {
      code: 'NHIS_CCC_REVIEW_REQUIRED', signals,
    })
  }
}
