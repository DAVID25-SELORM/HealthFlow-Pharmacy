import { supabase } from '../lib/supabase'
import { listBranchRecords, shouldUseBranchServer } from './branchServerApi'

export async function searchPrescribingDirectory({ search = '', nhisOnly = false, includeInactive = false, offset = 0, administration = false } = {}) {
  if (shouldUseBranchServer() && !includeInactive && !administration) {
    return listBranchRecords('nhis/prescribing-facilities', { directory: 'true', searchTerm: search, nhisOnly: String(nhisOnly), limit: 30 })
  }
  const { data, error } = await supabase.rpc('search_prescribing_directory', {
    p_search: search.trim(), p_nhis_only: nhisOnly, p_include_inactive: includeInactive,
    p_limit: 30, p_offset: offset,
  })
  if (error) throw error
  return data || []
}

export async function savePrescribingDirectoryEntry(entry) {
  const name = String(entry.facility_name || '').trim()
  if (!name) throw new Error('Enter a facility name.')
  const payload = {
    facility_name: name, is_shared: true, organization_id: null, branch_id: null,
    aliases: [...new Set((entry.aliases || []).map(s => s.trim()).filter(Boolean))],
    nhis_enabled: entry.nhis_enabled === true ? true : entry.nhis_enabled === false ? false : null,
    status: entry.status === 'inactive' ? 'inactive' : 'active',
    updated_at: new Date().toISOString(),
  }
  for (const key of ['facility_type', 'ownership_type', 'area', 'town', 'region']) payload[key] = String(entry[key] || '').trim() || null
  const table = supabase.from('nhis_prescribing_facilities')
  const query = entry.id ? table.update(payload).eq('id', entry.id).eq('is_shared', true) : table.insert(payload)
  const { data, error } = await query.select().single()
  if (error) throw error
  return data
}
