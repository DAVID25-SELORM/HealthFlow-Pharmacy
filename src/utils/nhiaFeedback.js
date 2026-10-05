export const INACTIVE_NHIS_MEMBER_MESSAGE =
  'Member details were found, but the NHIS membership is currently inactive. A CC code cannot be generated. Please ask the member to contact NHIA or renew their membership.'

export const getNhiaMemberFeedbackMessage = (message, fallback = '') => {
  const normalized = String(message || '').trim()
  if (!normalized) return fallback
  if (/no route to host|network is unreachable|connection refused|dns error|failed to lookup address/i.test(normalized)) {
    return 'HealthFlow could not connect to the NHIA verification service. No CC code was generated or verified. You can save the claim details and retry verification later. If this continues, ask your administrator to check the configured NHIA endpoint and its network access.'
  }

  if (
    /nhia member lookup did not return a cc code:\s*inactive\b/i.test(normalized) ||
    /^member status:\s*inactive\b/i.test(normalized)
  ) {
    return INACTIVE_NHIS_MEMBER_MESSAGE
  }

  return normalized
}
