import crypto from 'node:crypto'
import { config } from './config.js'

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

export const requireBranchToken = (request, response, next) => {
  const token = request.get('x-branch-token') || ''

  if (!safeTokenEquals(token, config.branchServerToken)) {
    response.status(401).json({ error: 'Branch server token is invalid or missing.' })
    return
  }

  next()
}
