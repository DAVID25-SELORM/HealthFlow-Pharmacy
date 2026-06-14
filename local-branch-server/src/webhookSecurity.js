import crypto from 'node:crypto'

const timingSafeEqual = (leftValue, rightValue) => {
  const left = Buffer.from(String(leftValue || ''), 'utf8')
  const right = Buffer.from(String(rightValue || ''), 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export const verifyHubtelWebhookSignature = ({
  rawBody = '',
  headers = {},
  secret = '',
} = {}) => {
  if (!secret) {
    throw new Error('Hubtel webhook verification is not configured.')
  }
  const signature =
    headers['x-hubtel-signature'] ||
    headers['x-hubtel-webhook-signature'] ||
    headers['x-signature']
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody || '')
    .digest('hex')
  if (!timingSafeEqual(expected, signature)) {
    throw new Error('Invalid Hubtel webhook signature.')
  }
}
