import { supabase } from '../lib/supabase'

export const getDeletedRecords = async () => {
  const { data, error } = await supabase
    .from('deleted_records')
    .select('*')
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
