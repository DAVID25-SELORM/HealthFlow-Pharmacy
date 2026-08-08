const REDACTED = '[REDACTED]'

const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[_-]?key|patient|member|hin|ghana|ccc|diagnos|medicine|prescription)/i

const sanitizeValue = (value, depth = 0) => {
  if (depth > 3) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(entry, depth + 1),
    ])
  )
}

const readHeader = (headers, name) => {
  try {
    return headers?.get?.(name) || null
  } catch {
    return null
  }
}

export const getRequestFailureDetails = (error, context = {}) => {
  const response = error?.context
  return {
    endpoint: context.endpoint || null,
    method: context.method || 'POST',
    status: Number(error?.status || error?.statusCode || response?.status || 0) || null,
    code: error?.code || error?.body?.code || null,
    requestId:
      error?.requestId ||
      readHeader(response?.headers, 'x-request-id') ||
      readHeader(response?.headers, 'sb-request-id') ||
      null,
    organizationId: context.organizationId || null,
    branchId: context.branchId || null,
    durationMs: Math.max(0, Math.round(Number(context.durationMs) || 0)),
    online: typeof navigator === 'undefined' ? null : navigator.onLine,
    message: String(error?.message || 'Request failed.'),
    response: sanitizeValue(error?.body || null),
  }
}

export const logRequestFailure = (label, error, context = {}) => {
  const details = getRequestFailureDetails(error, context)
  console.error(`[HealthFlow request] ${label}`, details)
  return details
}

