// Classify the source as well as the status: a profile/feature 403 is not
// evidence that the authentication session has been revoked.
export const classifyAuthFailure = (error, { authEndpoint = false } = {}) => {
  if (!error) return 'NONE'
  const status = Number(error.status || error.statusCode || error.context?.status || 0)
  const code = String(error.code || '').toLowerCase()
  const name = String(error.name || '').toLowerCase()
  const message = String(error.message || '').toLowerCase()
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500) return 'SERVER_ERROR'
  if (name === 'aborterror' || /timed? out|timeout/.test(message)) return 'NETWORK_TIMEOUT'
  if (name === 'authretryablefetcherror' || /failed to fetch|networkerror|network request|load failed|unable to reach|internet connection/.test(message)) return 'NETWORK_UNAVAILABLE'
  if (['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found'].includes(code) ||
      (authEndpoint && /refresh token.*(invalid|revoked|not found|already used)|invalid refresh token/.test(message))) return 'REFRESH_REVOKED'
  if (code === 'user_banned') return 'PROFILE_DISABLED'
  if (code === 'session_expired' || /jwt expired|token is expired/.test(message)) return 'SESSION_EXPIRED'
  if (['bad_jwt', 'pgrst301', 'pgrst303'].includes(code) || message.includes('invalid jwt')) return 'INVALID_JWT'
  if (name === 'authsessionmissingerror') return 'SESSION_MISSING'
  if (status === 401 || (authEndpoint && status === 403)) return 'AUTH_REJECTED'
  if (status === 403) return 'ACCESS_DENIED'
  if (status === 400) return 'APPLICATION_ERROR'
  return 'UNKNOWN_ERROR'
}

export const isConfirmedAuthFailure = (error, options) =>
  ['REFRESH_REVOKED', 'PROFILE_DISABLED', 'SESSION_EXPIRED', 'INVALID_JWT', 'SESSION_MISSING', 'AUTH_REJECTED']
    .includes(classifyAuthFailure(error, options))
