const normalizeErrorText = (error) => [
  typeof error === 'string' ? error : '',
  error?.name,
  error?.message,
  error?.code,
  error?.details,
]
  .filter(Boolean)
  .join(' ')
  .toLowerCase()

export const getErrorMessage = (error, fallback = 'Request failed.') => {
  const message = typeof error === 'string' ? error : error?.message
  return String(message || fallback)
}

export const isNetworkRequestError = (error) => {
  const text = normalizeErrorText(error)
  return (
    text.includes('failed to fetch') ||
    text.includes('fetch failed') ||
    text.includes('networkerror') ||
    text.includes('network error') ||
    text.includes('load failed') ||
    text.includes('unable to reach') ||
    text.includes('err_name_not_resolved') ||
    text.includes('err_internet_disconnected') ||
    text.includes('name_not_resolved') ||
    text.includes('internet disconnected') ||
    text.includes('aborted') ||
    text.includes('offline') ||
    text.includes('internet')
  )
}
