export const INACTIVE_NHIS_MEMBER_MESSAGE =
  'Member details were found, but the NHIS membership is currently inactive. A CC code cannot be generated. Please ask the member to contact NHIA or renew their membership.'

export const getNhiaMemberFeedbackMessage = (message, fallback = '') => {
  const normalized = String(message || '').trim()
  if (!normalized) return fallback

  if (
    /nhia member lookup did not return a cc code:\s*inactive\b/i.test(normalized) ||
    /^member status:\s*inactive\b/i.test(normalized)
  ) {
    return INACTIVE_NHIS_MEMBER_MESSAGE
  }

  return normalized
}
