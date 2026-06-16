import { invokeSupabaseFunction } from '../lib/supabase'

const PAYMENT_ADMIN_FUNCTION = 'payment-admin'

const invokePaymentAdmin = async (payload) => {
  const { data, error } = await invokeSupabaseFunction(PAYMENT_ADMIN_FUNCTION, {
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

export const getOnlinePaymentSettings = async () => {
  const response = await invokePaymentAdmin({ action: 'get_payment_settings' })
  return response.settings || null
}

export const saveOnlinePaymentSettings = async (settings) => {
  const response = await invokePaymentAdmin({
    action: 'save_payment_settings',
    ...settings,
  })
  return response.settings || null
}

export const initiateOnlinePayment = async (payload) => {
  const response = await invokePaymentAdmin({
    action: 'initiate_online_payment',
    ...payload,
  })
  return response
}
