import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const PAYSTACK_BASE_URL = 'https://api.paystack.co'
const textEncoder = new TextEncoder()

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const normalizeProvider = (value: unknown) =>
  normalizeText(value).toLowerCase() === 'paystack' ? 'paystack' : 'hubtel'
const toMoney = (value: unknown) => Math.round(Number(value || 0) * 100) / 100

const getFunctionEnv = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase payment webhook environment.')
  }
  return { supabaseUrl, serviceRoleKey }
}

const createAdminClient = (supabaseUrl: string, serviceRoleKey: string) =>
  createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

const bytesToHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, '0')).join('')

const signHmacHex = async (secret: string, rawBody: string, algorithm: 'SHA-256' | 'SHA-512') => {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(rawBody))
  return bytesToHex(signature)
}

const timingSafeEqual = (left = '', right = '') => {
  const a = normalizeText(left).toLowerCase()
  const b = normalizeText(right).toLowerCase()
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

const getPaymentSettingsRow = async (
  adminClient: ReturnType<typeof createAdminClient>,
  organizationId: string
) => {
  const { data, error } = await adminClient
    .from('pharmacy_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

const getAttemptByReference = async (
  adminClient: ReturnType<typeof createAdminClient>,
  reference: string
) => {
  const { data, error } = await adminClient
    .from('payment_attempts')
    .select('*')
    .eq('reference', reference)
    .maybeSingle()
  if (error) throw error
  return data
}

const extractReference = (provider: string, body: Record<string, any>) => {
  if (provider === 'paystack') {
    return normalizeText(body?.data?.reference || body?.reference)
  }
  return normalizeText(
    body?.data?.clientReference ||
      body?.data?.client_reference ||
      body?.clientReference ||
      body?.client_reference ||
      body?.reference
  )
}

const extractProviderPaymentId = (provider: string, body: Record<string, any>) => {
  if (provider === 'paystack') {
    return normalizeText(body?.data?.id || body?.data?.reference || body?.reference)
  }
  return normalizeText(
    body?.data?.transactionId ||
      body?.data?.checkoutId ||
      body?.data?.paylinkId ||
      body?.transactionId ||
      body?.checkoutId
  )
}

const isSuccessfulWebhook = (provider: string, body: Record<string, any>) => {
  if (provider === 'paystack') {
    return body?.event === 'charge.success' && body?.data?.status === 'success'
  }

  const status = normalizeText(
    body?.data?.status ||
      body?.data?.paymentStatus ||
      body?.status ||
      body?.paymentStatus
  ).toLowerCase()
  const responseCode = normalizeText(body?.data?.responseCode || body?.responseCode)
  return ['success', 'successful', 'paid', 'completed', 'complete'].includes(status) || responseCode === '0000'
}

const extractHubtelAmount = (body: Record<string, any>) =>
  toMoney(
    body?.data?.amount ??
      body?.data?.Amount ??
      body?.amount ??
      body?.Amount ??
      0
  )

const verifyPaystackTransaction = async (settings: Record<string, any>, reference: string, amount: number) => {
  if (!settings?.paystack_secret_key) throw new Error('Paystack secret key is not configured.')
  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${settings.paystack_secret_key}`, Accept: 'application/json' },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body?.data?.status !== 'success') {
    throw new Error(body?.message || 'Paystack transaction could not be verified.')
  }
  if (toMoney(Number(body?.data?.amount || 0) / 100) !== toMoney(amount)) {
    throw new Error('Paystack transaction amount does not match the sale total.')
  }
  return body
}

const verifyWebhookSignature = async ({
  provider,
  request,
  settings,
  rawBody,
}: {
  provider: string
  request: Request
  settings: Record<string, any>
  rawBody: string
}) => {
  if (provider === 'paystack') {
    if (!settings?.paystack_secret_key) throw new Error('Paystack secret key is not configured.')
    const expected = await signHmacHex(settings.paystack_secret_key, rawBody, 'SHA-512')
    const received = request.headers.get('x-paystack-signature') || ''
    if (!timingSafeEqual(received, expected)) throw new Error('Invalid Paystack webhook signature.')
    return
  }

  if (!settings?.hubtel_webhook_secret) {
    throw new Error('Hubtel webhook secret is not configured.')
  }
  const expected = await signHmacHex(settings.hubtel_webhook_secret, rawBody, 'SHA-256')
  const received =
    request.headers.get('x-hubtel-signature') ||
    request.headers.get('x-hubtel-webhook-signature') ||
    request.headers.get('x-signature') ||
    ''
  if (!timingSafeEqual(received, expected)) throw new Error('Invalid Hubtel webhook signature.')
}

const markAttemptPaid = async (
  adminClient: ReturnType<typeof createAdminClient>,
  attempt: Record<string, any>,
  body: Record<string, any>,
  providerPaymentId: string
) => {
  const timestamp = new Date().toISOString()
  const { error: attemptError } = await adminClient
    .from('payment_attempts')
    .update({
      status: 'paid',
      provider_payment_id: providerPaymentId || attempt.provider_payment_id || null,
      webhook_json: body,
      paid_at: timestamp,
      updated_at: timestamp,
    })
    .eq('reference', attempt.reference)
  if (attemptError) throw attemptError

  if (attempt.sale_id) {
    const { error: saleError } = await adminClient
      .from('sales')
      .update({
        payment_status: 'completed',
        amount_paid: attempt.amount,
        change_given: 0,
        updated_at: timestamp,
      })
      .eq('id', attempt.sale_id)
      .eq('organization_id', attempt.organization_id)
    if (saleError) throw saleError
  }
}

const markAttemptFailed = async (
  adminClient: ReturnType<typeof createAdminClient>,
  attempt: Record<string, any>,
  body: Record<string, any>,
  errorMessage = 'Provider reported payment failure.'
) => {
  const { error } = await adminClient
    .from('payment_attempts')
    .update({
      status: 'failed',
      webhook_json: body,
      error_message: errorMessage,
      failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('reference', attempt.reference)
  if (error) throw error
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const provider = normalizeProvider(new URL(request.url).searchParams.get('provider'))
    const rawBody = await request.text()
    const body = JSON.parse(rawBody || '{}') as Record<string, any>
    const reference = extractReference(provider, body)
    if (!reference) return json({ error: 'Payment reference is missing.' }, 400)

    const { supabaseUrl, serviceRoleKey } = getFunctionEnv()
    const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)
    const attempt = await getAttemptByReference(adminClient, reference)
    if (!attempt) return json({ error: 'Payment attempt was not found.' }, 404)
    if (attempt.status === 'paid') return json({ ok: true, status: 'paid' })
    if (attempt.provider !== provider) return json({ error: 'Payment provider mismatch.' }, 400)

    const settings = await getPaymentSettingsRow(adminClient, attempt.organization_id)
    await verifyWebhookSignature({ provider, request, settings: settings || {}, rawBody })

    if (!isSuccessfulWebhook(provider, body)) {
      await markAttemptFailed(adminClient, attempt, body)
      return json({ ok: true, status: 'failed' })
    }

    if (provider === 'paystack') {
      await verifyPaystackTransaction(settings || {}, reference, Number(attempt.amount || 0))
    } else if (extractHubtelAmount(body) !== toMoney(attempt.amount)) {
      throw new Error('Hubtel payment amount does not match the sale total.')
    }

    await markAttemptPaid(adminClient, attempt, body, extractProviderPaymentId(provider, body))
    return json({ ok: true, status: 'paid' })
  } catch (error) {
    console.error('[payment-webhook]', error)
    return json({ error: (error as Error)?.message || 'Payment webhook failed.' }, 400)
  }
})
