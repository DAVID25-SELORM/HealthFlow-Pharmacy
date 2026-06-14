import crypto from 'node:crypto'
import { config } from './config.js'
import { createId, db, json, nowIso, parseJson } from './db.js'
import { createLocalSale, getLocalSale, markLocalSalePaidAndQueueSync } from './salesRepository.js'
import { verifyHubtelWebhookSignature } from './webhookSecurity.js'

const PROVIDERS = new Set(['hubtel', 'paystack'])
const ONLINE_PAYMENT_METHODS = new Set(['momo', 'card'])
const SUCCESS_STATUSES = new Set(['success', 'successful', 'paid', 'completed', 'complete'])

const insertAttempt = db.prepare(`
  INSERT INTO payment_attempts (
    id, sale_id, provider, payment_method, reference, amount, currency, status,
    request_json, created_at, updated_at
  )
  VALUES (
    @id, @saleId, @provider, @paymentMethod, @reference, @amount, @currency, @status,
    @requestJson, @createdAt, @updatedAt
  )
`)

const updateAttemptInitiated = db.prepare(`
  UPDATE payment_attempts
  SET provider_payment_id = ?,
      authorization_url = ?,
      access_code = ?,
      response_json = ?,
      status = 'pending',
      error_message = NULL,
      updated_at = ?
  WHERE reference = ?
`)

const updateAttemptFailed = db.prepare(`
  UPDATE payment_attempts
  SET status = 'failed',
      response_json = COALESCE(?, response_json),
      webhook_json = COALESCE(?, webhook_json),
      error_message = ?,
      verified_at = COALESCE(?, verified_at),
      updated_at = ?
  WHERE reference = ?
`)

const updateAttemptPaid = db.prepare(`
  UPDATE payment_attempts
  SET status = 'paid',
      provider_payment_id = COALESCE(?, provider_payment_id),
      response_json = COALESCE(?, response_json),
      webhook_json = COALESCE(?, webhook_json),
      error_message = NULL,
      verified_at = ?,
      paid_at = COALESCE(paid_at, ?),
      updated_at = ?
  WHERE reference = ?
`)

const selectAttemptByReference = db.prepare('SELECT * FROM payment_attempts WHERE reference = ?')

const mapAttempt = (row) => row
  ? {
      id: row.id,
      saleId: row.sale_id,
      provider: row.provider,
      paymentMethod: row.payment_method,
      reference: row.reference,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      providerPaymentId: row.provider_payment_id,
      authorizationUrl: row.authorization_url,
      accessCode: row.access_code,
      request: parseJson(row.request_json, {}),
      response: parseJson(row.response_json, null),
      webhook: parseJson(row.webhook_json, null),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at,
      paidAt: row.paid_at,
      sale: getLocalSale(row.sale_id),
    }
  : null

const normalizeText = (value) => String(value || '').trim()

const normalizeProvider = (value, paymentMethod) => {
  const requested = normalizeText(value || config.payments.defaultProvider).toLowerCase()
  if (PROVIDERS.has(requested)) return requested
  if (paymentMethod === 'momo' && config.payments.hubtel.enabled) return 'hubtel'
  return 'paystack'
}

const normalizePaymentMethod = (value) => {
  const method = normalizeText(value).toLowerCase()
  if (!ONLINE_PAYMENT_METHODS.has(method)) {
    throw new Error('Online payment method must be momo or card.')
  }
  return method
}

const assertProviderConfigured = (provider) => {
  if (provider === 'paystack') {
    if (!config.payments.paystack.enabled || !config.payments.paystack.secretKey) {
      throw new Error('Paystack payments are not configured on this branch server.')
    }
    return
  }

  if (!config.payments.hubtel.enabled || !config.payments.hubtel.clientId || !config.payments.hubtel.clientSecret) {
    throw new Error('Hubtel payments are not configured on this branch server.')
  }
}

const createPaymentReference = () => {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const randomPart = crypto.randomBytes(5).toString('hex').toUpperCase()
  return `HF-${datePart}-${randomPart}`
}

const toMoney = (value) => Math.round(Number(value || 0) * 100) / 100

const toSubunit = (value) => Math.round(Number(value || 0) * 100)

const buildWebhookUrl = (provider) => {
  if (!config.payments.publicBaseUrl) return ''
  return `${config.payments.publicBaseUrl}/api/payments/webhook/${provider}`
}

const basicAuthHeader = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

const postJson = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const responseBody = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(responseBody?.message || responseBody?.error || `Payment provider returned HTTP ${response.status}.`)
  }
  return responseBody
}

const getJson = async (url, headers = {}) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  })
  const responseBody = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(responseBody?.message || responseBody?.error || `Payment provider returned HTTP ${response.status}.`)
  }
  return responseBody
}

const initializePaystackPayment = async ({ attempt, customerEmail, returnUrl }) => {
  const payload = {
    email: customerEmail || config.payments.paystack.defaultEmail || `${attempt.reference.toLowerCase()}@healthflow.local`,
    amount: toSubunit(attempt.amount),
    currency: attempt.currency,
    reference: attempt.reference,
    channels: attempt.paymentMethod === 'card' ? ['card'] : ['mobile_money'],
    callback_url: returnUrl || config.payments.returnUrl || undefined,
    metadata: {
      saleId: attempt.saleId,
      localReference: attempt.reference,
      paymentMethod: attempt.paymentMethod,
      source: 'HealthFlow POS',
    },
  }

  const response = await postJson(
    `${config.payments.paystack.baseUrl}/transaction/initialize`,
    payload,
    { Authorization: `Bearer ${config.payments.paystack.secretKey}` }
  )

  return {
    request: payload,
    response,
    providerPaymentId: response?.data?.reference || attempt.reference,
    authorizationUrl: response?.data?.authorization_url || '',
    accessCode: response?.data?.access_code || '',
  }
}

const initializeHubtelPayment = async ({ attempt, customerPhone, returnUrl }) => {
  const mobileNumber = normalizeText(customerPhone).replace(/\s+/g, '')
  if (!mobileNumber) {
    throw new Error('Customer mobile number is required for Hubtel payments.')
  }

  const callbackUrl = buildWebhookUrl('hubtel')
  if (!callbackUrl) {
    throw new Error('Set PAYMENT_PUBLIC_BASE_URL so Hubtel can call the payment webhook.')
  }

  const path = config.payments.hubtel.requestMoneyPath.replace(
    '{mobileNumber}',
    encodeURIComponent(mobileNumber)
  )
  const payload = {
    amount: attempt.amount,
    title: 'HealthFlow POS',
    description: `Payment for sale ${attempt.sale?.saleNumber || attempt.reference}`,
    clientReference: attempt.reference,
    callbackUrl,
    returnUrl: returnUrl || config.payments.returnUrl || undefined,
  }

  const response = await postJson(
    `${config.payments.hubtel.baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
    payload,
    {
      Authorization: basicAuthHeader(
        config.payments.hubtel.clientId,
        config.payments.hubtel.clientSecret
      ),
    }
  )

  return {
    request: payload,
    response,
    providerPaymentId: response?.data?.paylinkId || '',
    authorizationUrl: response?.data?.paylinkUrl || '',
    accessCode: '',
  }
}

export const initiatePayment = async (payload = {}) => {
  const paymentMethod = normalizePaymentMethod(payload.paymentMethod || payload.salePayload?.paymentMethod)
  const provider = normalizeProvider(payload.provider, paymentMethod)
  assertProviderConfigured(provider)

  const saleResult = createLocalSale({
    ...(payload.salePayload || {}),
    paymentMethod,
    paymentStatus: 'pending_payment',
  })
  const sale = saleResult.sale
  const reference = createPaymentReference()
  const timestamp = nowIso()
  const attempt = {
    id: createId(),
    saleId: sale.id,
    provider,
    paymentMethod,
    reference,
    amount: toMoney(sale.netAmount),
    currency: config.payments.currency,
    status: 'pending',
    requestJson: json({
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      paymentMethod,
      provider,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  insertAttempt.run(attempt)

  try {
    const mappedAttempt = { ...attempt, sale }
    const initialized = provider === 'paystack'
      ? await initializePaystackPayment({
          attempt: mappedAttempt,
          customerEmail: payload.customerEmail,
          returnUrl: payload.returnUrl,
        })
      : await initializeHubtelPayment({
          attempt: mappedAttempt,
          customerPhone: payload.customerPhone,
          returnUrl: payload.returnUrl,
        })

    updateAttemptInitiated.run(
      initialized.providerPaymentId,
      initialized.authorizationUrl,
      initialized.accessCode,
      json(initialized.response),
      nowIso(),
      reference
    )

    return {
      sale,
      saleNumber: sale.saleNumber,
      reference,
      provider,
      paymentMethod,
      amount: attempt.amount,
      currency: attempt.currency,
      authorizationUrl: initialized.authorizationUrl,
      accessCode: initialized.accessCode,
      status: 'pending',
    }
  } catch (error) {
    updateAttemptFailed.run(null, null, error.message || 'Payment initiation failed.', null, nowIso(), reference)
    throw error
  }
}

const timingSafeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

const verifyPaystackSignature = (rawBody, signature) => {
  const expected = crypto
    .createHmac('sha512', config.payments.paystack.secretKey)
    .update(rawBody || '')
    .digest('hex')
  if (!timingSafeEqual(expected, signature)) {
    throw new Error('Invalid Paystack webhook signature.')
  }
}

const verifyPaystackTransaction = async (reference) => {
  const response = await getJson(
    `${config.payments.paystack.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
    { Authorization: `Bearer ${config.payments.paystack.secretKey}` }
  )
  return response
}

const markAttemptPaid = ({ attempt, responseBody = null, webhookBody = null, providerPaymentId = '' }) => {
  const timestamp = nowIso()
  updateAttemptPaid.run(
    providerPaymentId,
    responseBody ? json(responseBody) : null,
    webhookBody ? json(webhookBody) : null,
    timestamp,
    timestamp,
    timestamp,
    attempt.reference
  )
  const paidSale = markLocalSalePaidAndQueueSync({
    saleId: attempt.saleId,
    paymentReference: attempt.reference,
  })
  return {
    attempt: mapAttempt(selectAttemptByReference.get(attempt.reference)),
    sale: paidSale,
  }
}

const assertAttemptMatchesAmount = (attempt, amount, provider) => {
  const receivedAmount = provider === 'paystack' ? toMoney(Number(amount || 0) / 100) : toMoney(amount)
  if (Math.abs(receivedAmount - Number(attempt.amount || 0)) > 0.01) {
    throw new Error('Payment amount does not match the sale total.')
  }
}

export const handlePaystackWebhook = async ({ rawBody = '', headers = {}, body = {} } = {}) => {
  assertProviderConfigured('paystack')
  verifyPaystackSignature(rawBody, headers['x-paystack-signature'])

  if (body?.event !== 'charge.success') {
    return { ignored: true, event: body?.event || '' }
  }

  const reference = normalizeText(body?.data?.reference)
  const attempt = mapAttempt(selectAttemptByReference.get(reference))
  if (!attempt) throw new Error('Unknown Paystack payment reference.')
  if (attempt.status === 'paid') return { alreadyPaid: true, attempt }

  const verification = await verifyPaystackTransaction(reference)
  const data = verification?.data || {}
  if (String(data.status || '').toLowerCase() !== 'success') {
    updateAttemptFailed.run(json(verification), json(body), 'Paystack transaction is not successful.', nowIso(), nowIso(), reference)
    return { verified: false, status: data.status || 'unknown' }
  }

  assertAttemptMatchesAmount(attempt, data.amount, 'paystack')
  return markAttemptPaid({
    attempt,
    responseBody: verification,
    webhookBody: body,
    providerPaymentId: data.id ? String(data.id) : data.reference || reference,
  })
}

export const handleHubtelWebhook = async ({ rawBody = '', headers = {}, body = {} } = {}) => {
  assertProviderConfigured('hubtel')
  verifyHubtelWebhookSignature({
    rawBody,
    headers,
    secret: config.payments.hubtel.webhookSecret,
  })

  const data = body?.data || {}
  const reference = normalizeText(
    data.clientReference ||
      data.client_reference ||
      body.clientReference ||
      body.client_reference
  )
  const attempt = mapAttempt(selectAttemptByReference.get(reference))
  if (!attempt) throw new Error('Unknown Hubtel payment reference.')
  if (attempt.status === 'paid') return { alreadyPaid: true, attempt }

  const status = normalizeText(data.status || data.Status || body.status || body.Status || body.responseCode).toLowerCase()
  const responseCode = normalizeText(body.responseCode || data.responseCode || data.ResponseCode)
  const isSuccessful = SUCCESS_STATUSES.has(status) || responseCode === '0000'
  if (!isSuccessful) {
    updateAttemptFailed.run(null, json(body), `Hubtel payment callback status: ${status || responseCode || 'unknown'}`, nowIso(), nowIso(), reference)
    return { verified: false, status: status || responseCode || 'unknown' }
  }

  assertAttemptMatchesAmount(attempt, data.amount ?? data.Amount ?? body.amount ?? body.Amount, 'hubtel')
  return markAttemptPaid({
    attempt,
    webhookBody: body,
    providerPaymentId: data.paylinkId || data.transactionId || '',
  })
}

export const getPaymentStatus = async (reference) => {
  const attempt = mapAttempt(selectAttemptByReference.get(reference))
  if (!attempt) return null

  if (
    attempt.provider === 'paystack' &&
    attempt.status === 'pending' &&
    config.payments.paystack.enabled &&
    config.payments.paystack.secretKey
  ) {
    const verification = await verifyPaystackTransaction(reference)
    const data = verification?.data || {}
    if (String(data.status || '').toLowerCase() === 'success') {
      assertAttemptMatchesAmount(attempt, data.amount, 'paystack')
      return markAttemptPaid({
        attempt,
        responseBody: verification,
        providerPaymentId: data.id ? String(data.id) : data.reference || reference,
      }).attempt
    }
  }

  return attempt
}
