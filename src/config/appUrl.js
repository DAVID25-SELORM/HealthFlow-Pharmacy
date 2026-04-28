const PRODUCTION_APP_URL = 'https://health-flow-pharmacy.vercel.app'

export const getPublicAppUrl = () => {
  const configuredUrl = import.meta.env.VITE_APP_URL?.trim()
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '')
  }

  if (typeof window === 'undefined') {
    return PRODUCTION_APP_URL
  }

  const origin = window.location.origin
  if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return PRODUCTION_APP_URL
  }

  return origin.replace(/\/+$/, '')
}

export const getPasswordRecoveryRedirectUrl = () => `${getPublicAppUrl()}/login?mode=recovery`
