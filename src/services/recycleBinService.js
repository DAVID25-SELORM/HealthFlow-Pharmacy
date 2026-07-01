import { supabase } from '../lib/supabase'

export const getDeletedRecords = async () => {
  const { data, error } = await supabase
    .from('deleted_records')
    .select('id, entity_type, entity_id, display_name, deleted_at, deleted_by')
    .order('deleted_at', { ascending: false })
  if (error) throw error
  return data || []
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
