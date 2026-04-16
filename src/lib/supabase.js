import { createClient } from '@supabase/supabase-js'

// Get environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY

const getDefaultStorageKey = (url) => {
  try {
    const hostname = new URL(url).hostname
    const [projectRef = ''] = hostname.split('.')
    return projectRef ? `sb-${projectRef}-auth-token` : ''
  } catch {
    return ''
  }
}

// Check if credentials are properly configured
const hasValidCredentials =
  supabaseUrl &&
  supabaseKey &&
  !supabaseUrl.includes('your_supabase') &&
  !supabaseKey.includes('your_supabase') &&
  supabaseUrl.startsWith('http')

export const supabaseAuthStorageKey = hasValidCredentials
  ? getDefaultStorageKey(supabaseUrl)
  : ''

// Create Supabase client only if credentials are valid
export const supabase = hasValidCredentials
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: supabaseAuthStorageKey,
      },
    })
  : null

export const clearSupabaseStoredSession = () => {
  if (typeof window === 'undefined' || !supabaseAuthStorageKey) {
    return
  }

  const keys = [
    supabaseAuthStorageKey,
    `${supabaseAuthStorageKey}-code-verifier`,
    `${supabaseAuthStorageKey}-user`,
  ]

  for (const key of keys) {
    try {
      window.localStorage.removeItem(key)
      window.sessionStorage.removeItem(key)
    } catch (error) {
      console.warn('Unable to clear stored Supabase session key:', key, error)
    }
  }
}

// Warning message in development
if (!hasValidCredentials && import.meta.env.DEV) {
  console.warn(
    'Supabase credentials not configured. Using sample data. Update your .env file to enable database features.'
  )
}

// Helper function to check if Supabase is configured
export const isSupabaseConfigured = () => {
  return supabase !== null
}
