import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

export const config = {
  api: {
    bodyParser: false,
  },
}

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const bridgeConfig = {
  upstreamBaseUrl: String(process.env.CLAIMIT_UPSTREAM_BASE_URL || '').trim().replace(/\/+$/, ''),
  bridgeToken: process.env.CLAIM_BRIDGE_TOKEN || '',
  bridgeTokenHeader: String(process.env.CLAIM_BRIDGE_TOKEN_HEADER || 'x-claim-bridge-token').trim().toLowerCase(),
  timeoutMs: Math.max(1000, toNumber(process.env.CLAIM_BRIDGE_TIMEOUT_MS, 30000)),
  maxBodyBytes: Math.max(1024, toNumber(process.env.CLAIM_BRIDGE_MAX_BODY_BYTES, 10 * 1024 * 1024)),
  upstreamApiKey: process.env.CLAIMIT_UPSTREAM_API_KEY || '',
  upstreamApiKeyHeader: String(process.env.CLAIMIT_UPSTREAM_API_KEY_HEADER || 'x-api-key').trim(),
  upstreamApiSecret: process.env.CLAIMIT_UPSTREAM_API_SECRET || '',
  upstreamApiSecretHeader: String(process.env.CLAIMIT_UPSTREAM_API_SECRET_HEADER || 'x-api-secret').trim(),
  upstreamBearerToken: process.env.CLAIMIT_UPSTREAM_BEARER_TOKEN || '',
  upstreamUsername: process.env.CLAIMIT_UPSTREAM_USERNAME || '',
  upstreamPassword: process.env.CLAIMIT_UPSTREAM_PASSWORD || '',
}

const hopByHopHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const json = (response, status, body) => {
  response.status(status)
  response.setHeader('cache-control', 'no-store')
  response.json(body)
}

const safeTokenEquals = (actual, expected) => {
  if (!actual || !expected) return false
  const actualBuffer = Buffer.from(String(actual), 'utf8')
  const expectedBuffer = Buffer.from(String(expected), 'utf8')
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0

    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > bridgeConfig.maxBodyBytes) {
        reject(new Error('Request body is too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })

const getPathSegments = (request) => {
  const path = request.query?.path
  if (Array.isArray(path)) return path
  if (typeof path === 'string' && path) return path.split('/').filter(Boolean)
  return []
}

const getQueryString = (request) => {
  const url = new URL(request.url || '/', 'https://healthflow.local')
  url.searchParams.delete('path')
  return url.searchParams.toString()
}

const buildTargetUrl = (request) => {
  const relativePath = getPathSegments(request).join('/')
  const target = new URL(`${bridgeConfig.upstreamBaseUrl}/${relativePath}`)
  const query = getQueryString(request)
  target.search = query ? `?${query}` : ''
  return target
}

const buildForwardHeaders = (request) => {
  const headers = {}
  for (const [name, value] of Object.entries(request.headers || {})) {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || lower === bridgeConfig.bridgeTokenHeader) continue
    if (Array.isArray(value)) headers[name] = value.join(', ')
    else if (value !== undefined) headers[name] = String(value)
  }

  headers['x-healthflow-claim-bridge'] = '1'

  if (bridgeConfig.upstreamApiKey) headers[bridgeConfig.upstreamApiKeyHeader || 'x-api-key'] = bridgeConfig.upstreamApiKey
  if (bridgeConfig.upstreamApiSecret) headers[bridgeConfig.upstreamApiSecretHeader || 'x-api-secret'] = bridgeConfig.upstreamApiSecret
  if (bridgeConfig.upstreamBearerToken) {
    headers.authorization = `Bearer ${bridgeConfig.upstreamBearerToken}`
  } else if (bridgeConfig.upstreamUsername || bridgeConfig.upstreamPassword) {
    headers.authorization = `Basic ${Buffer.from(`${bridgeConfig.upstreamUsername}:${bridgeConfig.upstreamPassword}`).toString('base64')}`
  }

  return headers
}

const requireBridgeToken = (request, response) => {
  const actual = request.headers?.[bridgeConfig.bridgeTokenHeader] || ''
  if (safeTokenEquals(actual, bridgeConfig.bridgeToken)) return true
  json(response, 401, { error: 'CLAIM-it bridge token is invalid or missing.' })
  return false
}

const setCorsHeaders = (request, response) => {
  const origin = request.headers?.origin || ''
  if (origin) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'Origin')
  }
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'access-control-allow-headers',
    `content-type, authorization, ${bridgeConfig.bridgeTokenHeader}`
  )
}

export default async function handler(request, response) {
  setCorsHeaders(request, response)

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  const pathSegments = getPathSegments(request)
  if (request.method === 'GET' && (pathSegments.length === 0 || pathSegments.join('/') === 'health')) {
    json(response, 200, {
      ok: true,
      mode: 'healthflow-vercel-claim-bridge',
      path: '/json-api',
      upstreamConfigured: Boolean(bridgeConfig.upstreamBaseUrl),
      tokenProtected: Boolean(bridgeConfig.bridgeToken),
    })
    return
  }

  if (!bridgeConfig.upstreamBaseUrl) {
    json(response, 503, { error: 'CLAIM-it upstream base URL is not configured.' })
    return
  }

  if (!bridgeConfig.bridgeToken) {
    json(response, 503, { error: 'CLAIM-it bridge token is not configured.' })
    return
  }

  if (!requireBridgeToken(request, response)) return

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), bridgeConfig.timeoutMs)

  try {
    const body = ['GET', 'HEAD'].includes(request.method || '') ? undefined : await readBody(request)
    const upstreamResponse = await fetch(buildTargetUrl(request), {
      method: request.method,
      headers: buildForwardHeaders(request),
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer())
    response.status(upstreamResponse.status)
    upstreamResponse.headers.forEach((value, name) => {
      if (!hopByHopHeaders.has(name.toLowerCase())) response.setHeader(name, value)
    })
    response.setHeader('cache-control', 'no-store')
    response.send(responseBody)
  } catch (error) {
    json(response, error?.name === 'AbortError' ? 504 : 502, {
      error: error?.name === 'AbortError'
        ? 'CLAIM-it upstream request timed out.'
        : 'CLAIM-it upstream request failed.',
      detail: error?.message || String(error),
    })
  } finally {
    clearTimeout(timeout)
  }
}
