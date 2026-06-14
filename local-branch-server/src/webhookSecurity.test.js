import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyHubtelWebhookSignature } from './webhookSecurity.js'

describe('Hubtel webhook security', () => {
  it('fails closed when no verification secret is configured', () => {
    expect(() => verifyHubtelWebhookSignature({
      rawBody: '{}',
      headers: {},
      secret: '',
    })).toThrow('Hubtel webhook verification is not configured.')
  })

  it('accepts only a valid HMAC signature', () => {
    const rawBody = '{"status":"success"}'
    const secret = 'hubtel-test-secret'
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

    expect(() => verifyHubtelWebhookSignature({
      rawBody,
      headers: { 'x-hubtel-signature': signature },
      secret,
    })).not.toThrow()
  })
})
