import { supabase } from '../lib/supabase'

const RECYCLE_BIN_LOAD_TIMEOUT_MS = 15000

const isMissingSummaryRpc = (error) =>
  ['42883', 'PGRST202'].includes(String(error?.code || '').toUpperCase())

export const getDeletedRecords = async () => {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), RECYCLE_BIN_LOAD_TIMEOUT_MS)
    : null

  try {
    let query = supabase.rpc('get_deleted_records_summary')
    if (controller && typeof query.abortSignal === 'function') {
      query = query.abortSignal(controller.signal)
    }

    let { data, error } = await query

    // Keep the page usable while the summary migration is being rolled out.
    if (error && isMissingSummaryRpc(error)) {
      let fallbackQuery = supabase
        .from('deleted_records')
        .select('id,entity_type,display_name,deleted_at')
        .order('deleted_at', { ascending: false })
      if (controller && typeof fallbackQuery.abortSignal === 'function') {
        fallbackQuery = fallbackQuery.abortSignal(controller.signal)
      }
      const fallback = await fallbackQuery
      data = fallback.data
      error = fallback.error
    }

    if (error) throw error
    return data || []
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error('Loading the Recycle Bin took too long. Check the connection and try again.')
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const restoreDeletedRecord = async (id) => {
  const { data, error } = await supabase.rpc('restore_deleted_record', { p_deleted_id: id })
  if (error) throw error
  return data
}

export const permanentlyDeleteRecord = async (id) => {
  const { data, error } = await supabase.rpc('permanently_delete_record', { p_deleted_id: id })
  if (error) throw error
  return data
}
