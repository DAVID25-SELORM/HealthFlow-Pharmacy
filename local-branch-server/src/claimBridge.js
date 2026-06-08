import crypto from 'node:crypto'
import express from 'express'
import { config } from './config.js'

const HOP_BY_HOP_HEADERS = new Set([
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

const safeTokenEquals = (actual, expected) => {
  if (!actual || !expected) {
    return false
  }

  const actualBuffer = Buffer.from(String(actual), 'utf8')
  const expectedBuffer = Buffer.from(String(expected), 'utf8')

  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

const joinUrl = (baseUrl, requestUrl) => {
  const [pathPart, queryPart = ''] = String(requestUrl || '/').split('?')
  const target = new URL(
    `${baseUrl.replace(/\/+$/, '')}/${pathPart.replace(/^\/+/, '')}`
  )
  target.search = queryPart ? `?${queryPart}` : ''
  return target
}

const readRequestBody = (request) => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  if (Buffer.isBuffer(request.body)) {
    return request.body.length > 0 ? request.body : undefined
  }

  if (typeof request.rawBody === 'string' && request.rawBody.length > 0) {
    return request.rawBody
  }

  if (request.body && typeof request.body === 'object' && Object.keys(request.body).length > 0) {
    return JSON.stringify(request.body)
  }

  return undefined
}

const buildForwardHeaders = (request) => {
  const headers = {}
  const bridgeTokenHeader = config.claimBridge.tokenHeader.toLowerCase()

  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === bridgeTokenHeader) {
      continue
    }

    if (Array.isArray(value)) {
      headers[name] = value.join(', ')
    } else if (value !== undefined) {
      headers[name] = String(value)
    }
  }

  headers['x-healthflow-claim-bridge'] = '1'

  if (config.claimBridge.allowEnvCredentialOverrides && config.claimBridge.upstreamApiKey) {
    headers[config.claimBridge.upstreamApiKeyHeader || 'x-api-key'] = config.claimBridge.upstreamApiKey
  }

  if (config.claimBridge.allowEnvCredentialOverrides && config.claimBridge.upstreamApiSecret) {
    headers[config.claimBridge.upstreamApiSecretHeader || 'x-api-secret'] = config.claimBridge.upstreamApiSecret
  }

  if (config.claimBridge.allowEnvCredentialOverrides && config.claimBridge.upstreamBearerToken) {
    headers.Authorization = `Bearer ${config.claimBridge.upstreamBearerToken}`
  } else if (
    config.claimBridge.allowEnvCredentialOverrides &&
    (config.claimBridge.upstreamUsername || config.claimBridge.upstreamPassword)
  ) {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.claimBridge.upstreamUsername}:${config.claimBridge.upstreamPassword}`
    ).toString('base64')}`
  }

  return headers
}

const requireClaimBridgeToken = (request, response) => {
  if (!config.claimBridge.accessToken) {
    response.status(503).json({ error: 'CLAIM-it bridge token is not configured.' })
    return false
  }

  const token = request.get(config.claimBridge.tokenHeader) || ''
  if (safeTokenEquals(token, config.claimBridge.accessToken)) {
    return true
  }

  response.status(401).json({ error: 'CLAIM-it bridge token is invalid or missing.' })
  return false
}

export const createClaimBridgeRouter = () => {
  const router = express.Router()

  router.use(express.raw({
    type: ['application/xml', 'text/xml', 'text/plain', 'application/octet-stream', 'application/*+xml'],
    limit: config.claimBridge.bodyLimit,
  }))

  router.get(['/', '/health'], (request, response) => {
    if (!requireClaimBridgeToken(request, response)) {
      return
    }

    response.json({
      ok: true,
      mode: 'claimit-production-bridge',
      upstreamConfigured: Boolean(config.claimBridge.upstreamBaseUrl),
      tokenProtected: Boolean(config.claimBridge.accessToken),
      envCredentialInjectionEnabled: Boolean(config.claimBridge.allowEnvCredentialOverrides),
    })
  })

  router.all('*', async (request, response, next) => {
    if (!config.claimBridge.upstreamBaseUrl) {
      response.status(503).json({ error: 'CLAIM-it upstream base URL is not configured.' })
      return
    }

    if (!requireClaimBridgeToken(request, response)) {
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.claimBridge.timeoutMs)

    try {
      const upstreamResponse = await fetch(joinUrl(config.claimBridge.upstreamBaseUrl, request.url), {
        method: request.method,
        headers: buildForwardHeaders(request),
        body: readRequestBody(request),
        redirect: 'manual',
        signal: controller.signal,
      })
      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer())

      response.status(upstreamResponse.status)
      upstreamResponse.headers.forEach((value, name) => {
        const lowerName = name.toLowerCase()
        if (!HOP_BY_HOP_HEADERS.has(lowerName)) {
          response.setHeader(name, value)
        }
      })
      response.setHeader('Cache-Control', 'no-store')
      response.send(responseBody)
    } catch (error) {
      if (error.name === 'AbortError') {
        response.status(504).json({ error: 'CLAIM-it upstream request timed out.' })
        return
      }

      next(error)
    } finally {
      clearTimeout(timeout)
    }
  })

  return router
}
