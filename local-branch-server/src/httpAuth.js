import crypto from 'node:crypto'
import { config } from './config.js'

export const BRANCH_AUTH_COOKIE = 'healthflow_branch_session'

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

const readCookie = (request, name) => {
  const cookieHeader = String(request.get('Cookie') || '')
  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.trim().split('=')
    if (key === name) {
      return decodeURIComponent(valueParts.join('=') || '')
    }
  }
  return ''
}

export const getBranchAuthCookie = () =>
  `${BRANCH_AUTH_COOKIE}=${encodeURIComponent(config.branchServerToken)}; Path=/; HttpOnly; SameSite=Strict`

export const requireBranchToken = (request, response, next) => {
  const token =
    request.get('x-branch-token') ||
    readCookie(request, BRANCH_AUTH_COOKIE) ||
    ''

  if (!safeTokenEquals(token, config.branchServerToken)) {
    response.status(401).json({ error: 'Branch server token is invalid or missing.' })
    return
  }

  next()
}
