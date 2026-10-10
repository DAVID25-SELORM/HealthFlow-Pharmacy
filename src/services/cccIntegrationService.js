import { invokeSupabaseFunction } from '../lib/supabase'

export async function cccIntegration(action, payload = {}) {
  const { data, error } = await invokeSupabaseFunction('tier-access', { body: { ...payload, action } })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}
