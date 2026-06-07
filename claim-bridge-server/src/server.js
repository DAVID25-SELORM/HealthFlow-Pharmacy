import http from 'node:http'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const normalizePath = (value, fallback = '/json-api') => {
  const path = String(value || fallback).trim() || fallback
  const prefixed = path.startsWith('/') ? path : `/${path}`
  return prefixed.replace(/\/+$/, '') || '/'
}

const config = {
  port: toNumber(process.env.PORT, 4780),
  publicPath: normalizePath(process.env.CLAIM_BRIDGE_PUBLIC_PATH, '/json-api'),
  upstreamBaseUrl: String(process.env.CLAIMIT_UPSTREAM_BASE_URL || '').trim().replace(/\/+$/, ''),
  bridgeToken: process.env.CLAIM_BRIDGE_TOKEN || '',
  bridgeTokenHeader: String(process.env.CLAIM_BRIDGE_TOKEN_HEADER || 'x-claim-bridge-token').trim().toLowerCase(),
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
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

const requiredEnv = [
  ['CLAIMIT_UPSTREAM_BASE_URL', config.upstreamBaseUrl],
  ['CLAIM_BRIDGE_TOKEN', config.bridgeToken],
]

for (const [name, value] of requiredEnv) {
  if (!value) {
    throw new Error(`Set ${name} before starting the CLAIM-it bridge.`)
  }
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
  const payload = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

const safeTokenEquals = (actual, expected) => {
  if (!actual || !expected) return false
  const actualBuffer = Buffer.from(String(actual), 'utf8')
  const expectedBuffer = Buffer.from(String(expected), 'utf8')
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

const isAllowedOrigin = (origin = '') => {
  if (!origin) return true
  if (config.allowedOrigins.includes('*')) return true
  return config.allowedOrigins.includes(origin.replace(/\/+$/, ''))
}

const setCorsHeaders = (request, response) => {
  const origin = request.headers.origin || ''
  if (origin && isAllowedOrigin(origin)) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('vary', 'Origin')
  }
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'access-control-allow-headers',
    `content-type, authorization, ${config.bridgeTokenHeader}`
  )
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0

    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > config.maxBodyBytes) {
        reject(new Error('Request body is too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })

const buildTargetUrl = (requestUrl = '/') => {
  const incoming = new URL(requestUrl, 'http://claim-bridge.local')
  const relativePath = incoming.pathname.startsWith(config.publicPath)
    ? incoming.pathname.slice(config.publicPath.length) || '/'
    : incoming.pathname
  const target = new URL(`${config.upstreamBaseUrl}/${relativePath.replace(/^\/+/, '')}`)
  target.search = incoming.search
  return target
}

const buildForwardHeaders = (request) => {
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || lower === config.bridgeTokenHeader) continue
    if (Array.isArray(value)) headers[name] = value.join(', ')
    else if (value !== undefined) headers[name] = String(value)
  }

  headers['x-healthflow-claim-bridge'] = '1'

  if (config.upstreamApiKey) headers[config.upstreamApiKeyHeader || 'x-api-key'] = config.upstreamApiKey
  if (config.upstreamApiSecret) headers[config.upstreamApiSecretHeader || 'x-api-secret'] = config.upstreamApiSecret
  if (config.upstreamBearerToken) {
    headers.authorization = `Bearer ${config.upstreamBearerToken}`
  } else if (config.upstreamUsername || config.upstreamPassword) {
    headers.authorization = `Basic ${Buffer.from(`${config.upstreamUsername}:${config.upstreamPassword}`).toString('base64')}`
  }

  return headers
}

const requireBridgeToken = (request, response) => {
  const actual = request.headers[config.bridgeTokenHeader] || ''
  if (safeTokenEquals(actual, config.bridgeToken)) return true
  json(response, 401, { error: 'CLAIM-it bridge token is invalid or missing.' })
  return false
}

const proxyRequest = async (request, response) => {
  if (!requireBridgeToken(request, response)) return

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const body = ['GET', 'HEAD'].includes(request.method || '') ? undefined : await readBody(request)
    const upstreamResponse = await fetch(buildTargetUrl(request.url), {
      method: request.method,
      headers: buildForwardHeaders(request),
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer())
    const headers = {}
    upstreamResponse.headers.forEach((value, name) => {
      if (!hopByHopHeaders.has(name.toLowerCase())) headers[name] = value
    })
    headers['cache-control'] = 'no-store'
    response.writeHead(upstreamResponse.status, headers)
    response.end(responseBody)
  } catch (error) {
    const isTimeout = error?.name === 'AbortError'
    json(response, isTimeout ? 504 : 502, {
      error: isTimeout ? 'CLAIM-it upstream request timed out.' : 'CLAIM-it upstream request failed.',
      detail: error?.message || String(error),
    })
  } finally {
    clearTimeout(timeout)
  }
}

const server = http.createServer(async (request, response) => {
  setCorsHeaders(request, response)

  if (!isAllowedOrigin(request.headers.origin || '')) {
    json(response, 403, { error: 'Origin is not allowed for this CLAIM-it bridge.' })
    return
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const pathname = new URL(request.url || '/', 'http://claim-bridge.local').pathname
  if (pathname === '/health' || pathname === `${config.publicPath}/health`) {
    json(response, 200, {
      ok: true,
      mode: 'healthflow-claim-bridge',
      path: config.publicPath,
      upstreamConfigured: Boolean(config.upstreamBaseUrl),
      tokenProtected: Boolean(config.bridgeToken),
    })
    return
  }

  if (pathname === config.publicPath || pathname.startsWith(`${config.publicPath}/`)) {
    await proxyRequest(request, response)
    return
  }

  json(response, 404, { error: 'Not found.' })
})

server.listen(config.port, () => {
  console.log(`HealthFlow CLAIM-it bridge listening on port ${config.port}${config.publicPath}`)
})
