import { supabase } from '../lib/supabase'
import { getCustomerAuthRedirectUrl } from '../config/appUrl'

const FUNCTION_NAME = 'customer-epharmacy'
const PRESCRIPTION_BUCKET = 'epharmacy-prescriptions'
const MAX_PRESCRIPTION_BYTES = 8 * 1024 * 1024
const ALLOWED_PRESCRIPTION_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const invokeCustomerFunction = async (body) => {
  if (!supabase) {
    throw new Error('Supabase credentials are not configured.')
  }

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body })
  if (error) {
    let message = error.message || 'Unable to reach the customer pharmacy.'
    try {
      const response = error.context?.clone?.()
      if (response) {
        const payload = await response.json()
        message = payload?.error || payload?.message || message
      }
    } catch {
      // Keep the function error when the response is not JSON.
    }
    throw new Error(message)
  }
  if (data?.error) {
    throw new Error(data.error)
  }
  return data
}

export const getCustomerMarketplace = async (filters = {}) =>
  invokeCustomerFunction({
    action: 'get_marketplace',
    searchTerm: String(filters.searchTerm || '').trim(),
    facilityId: String(filters.facilityId || '').trim(),
    limit: Number(filters.limit || 120),
  })

export const getCustomerAccount = async () =>
  invokeCustomerFunction({ action: 'get_account' })

export const saveCustomerProfile = async (profile) =>
  invokeCustomerFunction({ action: 'save_profile', profile })

export const createCustomerOrder = async (order) =>
  invokeCustomerFunction({ action: 'create_order', order })

export const signInCustomerWithProvider = async (provider) => {
  if (!supabase) {
    throw new Error('Supabase credentials are not configured.')
  }
  if (!['google', 'apple'].includes(provider)) {
    throw new Error('Unsupported social sign-in provider.')
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: getCustomerAuthRedirectUrl(),
      queryParams: provider === 'google' ? { prompt: 'select_account' } : undefined,
    },
  })
  if (error) throw error
  return data
}

export const sendCustomerMagicLink = async (email) => {
  if (!supabase) {
    throw new Error('Supabase credentials are not configured.')
  }
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Enter a valid email address.')
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: getCustomerAuthRedirectUrl(),
      shouldCreateUser: true,
      data: { account_type: 'customer' },
    },
  })
  if (error) throw error
}

export const uploadCustomerPrescription = async (userId, file) => {
  if (!supabase || !userId) {
    throw new Error('Sign in before uploading a prescription.')
  }
  if (!file) {
    throw new Error('Choose a prescription file.')
  }
  if (!ALLOWED_PRESCRIPTION_TYPES.has(file.type)) {
    throw new Error('Prescription must be a PDF, JPG, PNG, or WebP file.')
  }
  if (file.size > MAX_PRESCRIPTION_BYTES) {
    throw new Error('Prescription file must be 8MB or smaller.')
  }

  const extension = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const path = `${userId}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage
    .from(PRESCRIPTION_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error

  return {
    path,
    name: file.name,
    type: file.type,
    size: file.size,
  }
}

export const removeCustomerPrescription = async (path) => {
  if (!supabase || !path) return
  await supabase.storage.from(PRESCRIPTION_BUCKET).remove([path])
}

export const isPrescriptionListing = (listing = {}) =>
  Boolean(listing.prescription_required) ||
  String(listing.sale_class || '').toLowerCase() === 'prescription'

export const getCustomerCheckoutRequirements = ({
  listing,
  fulfillmentMethod,
  orderingFor = 'self',
}) => {
  const prescription = isPrescriptionListing(listing)
  return {
    prescription,
    requiresDeliveryAddress: fulfillmentMethod === 'delivery',
    requiresPatientDetails: prescription || orderingFor !== 'self',
    requiresClinicalDetails: prescription,
    requiresPrescriptionUpload: prescription,
  }
}
