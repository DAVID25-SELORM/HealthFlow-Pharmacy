import { invokeSupabaseFunction } from '../lib/supabase'

const TIER_ACCESS_FUNCTION = 'tier-access'

export const invokeTierAccess = async (payload) => {
  const { data, error } = await invokeSupabaseFunction(TIER_ACCESS_FUNCTION, {
    body: payload,
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}
