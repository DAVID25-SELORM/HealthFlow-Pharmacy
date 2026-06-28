export const createOfflineLoginRateLimiter = ({
  windowMs,
  maxRequests,
  auditRateLimited,
  now = () => Date.now(),
}) => {
  const buckets = new Map()

  const middleware = (request, response, next) => {
    const currentTime = now()
    const ipAddress = request.ip || request.socket?.remoteAddress || 'unknown'
    const existing = buckets.get(String(ipAddress))
    const bucket = !existing || currentTime >= existing.resetAt
      ? { count: 0, resetAt: currentTime + windowMs }
      : existing
    bucket.count += 1
    buckets.set(String(ipAddress), bucket)
    if (bucket.count > maxRequests) {
      auditRateLimited({ email: request.body?.email, ipAddress })
      response.setHeader('Retry-After', Math.ceil((bucket.resetAt - currentTime) / 1000))
      response.status(429).json({ error: 'Too many offline login attempts. Please try again shortly.' })
      return
    }
    next()
  }

  middleware.prune = () => {
    const currentTime = now()
    for (const [key, bucket] of buckets.entries()) {
      if (currentTime >= bucket.resetAt) buckets.delete(key)
    }
  }

  return middleware
}
