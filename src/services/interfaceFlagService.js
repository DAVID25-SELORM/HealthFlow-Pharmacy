import { supabase } from '../lib/supabase'

// Platform administrators only; the database enforces that, not this file.
export const setOrganizationInterfaceFlag = async (organizationId, flag, value) => {
  const { data, error } = await supabase.rpc('set_organization_interface_flag', {
    p_org: organizationId,
    p_flag: flag,
    p_value: Boolean(value),
  })

  if (error) {
    throw error
  }

  return data || {}
}
