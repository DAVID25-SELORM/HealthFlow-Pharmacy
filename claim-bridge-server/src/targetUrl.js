export const buildScopedTarget = (upstreamBaseUrl, pathSegments, search = '') => {
  const base = new URL(`${upstreamBaseUrl.replace(/\/+$/, '')}/`)
  const segments = pathSegments.map((segment) => {
    let decoded
    try { decoded = decodeURIComponent(segment) } catch { throw Object.assign(new Error('Invalid API path.'), { status: 400 }) }
    const hasControl = [...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/%?#]/.test(decoded) || hasControl) {
      throw Object.assign(new Error('Invalid API path.'), { status: 400 })
    }
    return encodeURIComponent(decoded)
  })
  const target = new URL(segments.join('/'), base)
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw Object.assign(new Error('Invalid API path.'), { status: 400 })
  }
  target.search = search
  return target
}
