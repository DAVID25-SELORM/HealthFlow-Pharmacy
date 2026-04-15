import { createClient } from '@supabase/supabase-js'

// Get environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY

// Check if credentials are properly configured
const hasValidCredentials = 
  supabaseUrl && 
  supabaseKey && 
  !supabaseUrl.includes('your_supabase') && 
  !supabaseKey.includes('your_supabase') &&
  supabaseUrl.startsWith('http')

// Create Supabase client only if credentials are valid
export const supabase = hasValidCredentials 
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      }
    })
  : null

// Warning message in development
if (!hasValidCredentials && import.meta.env.DEV) {
  console.warn('⚠️ Supabase credentials not configured. Using sample data. Update your .env file to enable database features.')
}

// Helper function to check if Supabase is configured
export const isSupabaseConfigured = () => {
  return supabase !== null
}
