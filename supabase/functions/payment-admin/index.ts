import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const HUBTEL_BASE_URL = 'https://devp-sms03726-api.hubtel.com/v1'
const HUBTEL_REQUEST_MONEY_PATH = '/request-money/{mobileNumber}'
const PAYSTACK_BASE_URL = 'https://api.paystack.co'
const SECRET_MASK = '********'

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const toMoney = (value: unknown) => Math.round(Number(value || 0) * 100) / 100
const toSubunit = (value: unknown) => Math.round(Number(value || 0) * 100)

const getFunctionEnv = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error('Missing Supabase payment function environment.')
  }
  return { supabaseUrl, supabaseAnonKey, serviceRoleKey }
}

const createUserClient = (authorization: string, supabaseUrl: string, supabaseAnonKey: string) =>
  createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

const createAdminClient = (supabaseUrl: string, serviceRoleKey: string) =>
  createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

const requesterHasRole = (profile: Record<string, any>, roles: string[]) => {
  const assigned = Array.isArray(profile.assigned_roles) ? profile.assigned_roles : []
  return roles.some((role) => role === profile.role || assigned.includes(role))
}

const getRequesterProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string
) => {
  const { data, error } = await adminClient
    .from('users')
    .select('id, email, role, assigned_roles, organization_id, branch_id')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  return data
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

const maskSettings = (row: Record<string, any> | null) => ({
  enabled: Boolean(row?.online_payments_enabled),
  defaultProvider: row?.online_payment_default_provider || 'hubtel',
  returnUrl: row?.payment_return_url || '',
  hubtel: {
    clientId: row?.hubtel_client_id || '',
    merchantAccountNumber: row?.hubtel_merchant_account_number || '',
    hasClientSecret: Boolean(row?.hubtel_client_secret),
    hasWebhookSecret: Boolean(row?.hubtel_webhook_secret),
  },
  paystack: {
    publicKey: row?.paystack_public_key || '',
    hasSecretKey: Boolean(row?.paystack_secret_key),
  },
})

const isMask = (value: unknown) => normalizeText(value) === SECRET_MASK

const savePaymentSettings = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: Record<string, any>,
  payload: Record<string, unknown>
) => {
  if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
    return json({ error: 'Only admin users can manage payment settings.' }, 403)
  }
  const organizationId = normalizeText(requesterProfile.organization_id)
  if (!organizationId) return json({ error: 'Admin account is missing organization context.' }, 400)

  const existing = await getPaymentSettingsRow(adminClient, organizationId)
  const hubtel = (payload.hubtel || {}) as Record<string, unknown>
  const paystack = (payload.paystack || {}) as Record<string, unknown>
  const defaultProvider = normalizeText(payload.defaultProvider).toLowerCase() === 'paystack'
    ? 'paystack'
    : 'hubtel'

  const updatePayload = {
    online_payments_enabled: Boolean(payload.enabled),
    online_payment_default_provider: defaultProvider,
    payment_return_url: normalizeText(payload.returnUrl) || null,
    hubtel_client_id: normalizeText(hubtel.clientId) || null,
    hubtel_client_secret: isMask(hubtel.clientSecret)
      ? existing?.hubtel_client_secret || null
      : normalizeText(hubtel.clientSecret) || existing?.hubtel_client_secret || null,
    hubtel_merchant_account_number: normalizeText(hubtel.merchantAccountNumber) || null,
    hubtel_webhook_secret: isMask(hubtel.webhookSecret)
      ? existing?.hubtel_webhook_secret || null
      : normalizeText(hubtel.webhookSecret) || existing?.hubtel_webhook_secret || null,
    paystack_public_key: normalizeText(paystack.publicKey) || null,
    paystack_secret_key: isMask(paystack.secretKey)
      ? existing?.paystack_secret_key || null
      : normalizeText(paystack.secretKey) || existing?.paystack_secret_key || null,
    updated_at: new Date().toISOString(),
  }

  if (!existing?.id) {
    return json({ error: 'Save facility settings first before configuring payments.' }, 400)
  }

  const { data, error } = await adminClient
    .from('pharmacy_settings')
    .update(updatePayload)
    .eq('id', existing.id)
    .select('*')
    .single()
  if (error) throw error
  return json({ settings: maskSettings(data) })
}

const assertProviderConfigured = (settings: Record<string, any>, provider: string) => {
  if (!settings?.online_payments_enabled) {
    throw new Error('Online payments are not enabled for this facility.')
  }
  if (provider === 'hubtel') {
    if (!settings.hubtel_client_id || !settings.hubtel_client_secret) {
      throw new Error('Hubtel payments are not fully configured.')
    }
    return
  }
  if (!settings.paystack_secret_key) {
    throw new Error('Paystack payments are not fully configured.')
  }
}

const randomReference = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `HF-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${hex}`
}

const basicAuth = (username: string, password: string) =>
  `Basic ${btoa(`${username}:${password}`)}`

const postJson = async (url: string, body: Record<string, unknown>, headers: Record<string, string>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const responseBody = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(responseBody?.message || responseBody?.error || `Payment provider returned HTTP ${response.status}.`)
  }
  return responseBody
}

const getWebhookUrl = (supabaseUrl: string, provider: string) =>
  `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/payment-webhook?provider=${provider}`

const initializeHubtel = async ({
  settings,
  attempt,
  customerPhone,
  returnUrl,
  supabaseUrl,
}: Record<string, any>) => {
  const mobileNumber = normalizeText(customerPhone).replace(/\s+/g, '')
  if (!mobileNumber) throw new Error('Customer mobile number is required for Hubtel payment.')
  const path = HUBTEL_REQUEST_MONEY_PATH.replace('{mobileNumber}', encodeURIComponent(mobileNumber))
  const payload = {
    amount: attempt.amount,
    title: 'HealthFlow POS',
    description: `Payment for ${attempt.reference}`,
    clientReference: attempt.reference,
    callbackUrl: getWebhookUrl(supabaseUrl, 'hubtel'),
    returnUrl: returnUrl || settings.payment_return_url || undefined,
  }
  const response = await postJson(`${HUBTEL_BASE_URL}${path}`, payload, {
    Authorization: basicAuth(settings.hubtel_client_id, settings.hubtel_client_secret),
  })
  return {
    request: payload,
    response,
    providerPaymentId: response?.data?.paylinkId || response?.data?.checkoutId || '',
    authorizationUrl: response?.data?.paylinkUrl || response?.data?.checkoutUrl || '',
    accessCode: '',
  }
}

const initializePaystack = async ({
  settings,
  attempt,
  customerEmail,
  returnUrl,
}: Record<string, any>) => {
  const payload = {
    email: customerEmail || `${attempt.reference.toLowerCase()}@healthflow.local`,
    amount: toSubunit(attempt.amount),
    currency: attempt.currency,
    reference: attempt.reference,
    channels: attempt.payment_method === 'card' ? ['card'] : ['mobile_money'],
    callback_url: returnUrl || settings.payment_return_url || undefined,
    metadata: {
      organizationId: attempt.organization_id,
      localReference: attempt.reference,
      source: 'HealthFlow Online POS',
    },
  }
  const response = await postJson(`${PAYSTACK_BASE_URL}/transaction/initialize`, payload, {
    Authorization: `Bearer ${settings.paystack_secret_key}`,
  })
  return {
    request: payload,
    response,
    providerPaymentId: response?.data?.reference || attempt.reference,
    authorizationUrl: response?.data?.authorization_url || '',
    accessCode: response?.data?.access_code || '',
  }
}

const initiateOnlinePayment = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: Record<string, any>,
  payload: Record<string, unknown>,
  supabaseUrl: string
) => {
  const organizationId = normalizeText(requesterProfile.organization_id)
  if (!organizationId) return json({ error: 'User account is missing organization context.' }, 400)
  const paymentMethod = normalizeText(payload.paymentMethod || (payload.salePayload as any)?.paymentMethod).toLowerCase()
  if (!['momo', 'card'].includes(paymentMethod)) {
    return json({ error: 'Online payment method must be momo or card.' }, 400)
  }
  const settings = await getPaymentSettingsRow(adminClient, organizationId)
  const provider = normalizeText(payload.provider).toLowerCase() === 'paystack'
    ? 'paystack'
    : paymentMethod === 'momo'
      ? 'hubtel'
      : 'paystack'
  assertProviderConfigured(settings || {}, provider)

  const salePayload = (payload.salePayload || {}) as Record<string, any>
  const amount = toMoney(salePayload.amountPaid || salePayload.netAmount || 0)
  if (amount <= 0) return json({ error: 'Payment amount must be greater than zero.' }, 400)

  const reference = randomReference()
  const attempt = {
    organization_id: organizationId,
    branch_id: normalizeText(salePayload.branchId) || normalizeText(requesterProfile.branch_id) || null,
    sale_id: normalizeText(payload.saleId || salePayload.saleId) || null,
    sale_number: normalizeText(payload.saleNumber || salePayload.saleNumber) || null,
    provider,
    payment_method: paymentMethod,
    reference,
    amount,
    currency: 'GHS',
    status: 'pending',
    sale_payload: salePayload,
    created_by: requesterProfile.id,
  }
  const { data: inserted, error: insertError } = await adminClient
    .from('payment_attempts')
    .insert(attempt)
    .select('*')
    .single()
  if (insertError) throw insertError

  try {
    const initialized = provider === 'hubtel'
      ? await initializeHubtel({
          settings,
          attempt: inserted,
          customerPhone: payload.customerPhone,
          returnUrl: payload.returnUrl,
          supabaseUrl,
        })
      : await initializePaystack({
          settings,
          attempt: inserted,
          customerEmail: payload.customerEmail,
          returnUrl: payload.returnUrl,
        })

    const { data: updated, error: updateError } = await adminClient
      .from('payment_attempts')
      .update({
        provider_payment_id: initialized.providerPaymentId || null,
        authorization_url: initialized.authorizationUrl || null,
        access_code: initialized.accessCode || null,
        request_json: initialized.request,
        response_json: initialized.response,
        updated_at: new Date().toISOString(),
      })
      .eq('reference', reference)
      .select('*')
      .single()
    if (updateError) throw updateError

    return json({
      reference,
      provider,
      paymentMethod,
      amount,
      currency: 'GHS',
      authorizationUrl: updated.authorization_url || '',
      accessCode: updated.access_code || '',
      status: 'pending',
    }, 201)
  } catch (error) {
    await adminClient
      .from('payment_attempts')
      .update({
        status: 'failed',
        error_message: (error as Error)?.message || 'Payment initiation failed.',
        failed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('reference', reference)
    throw error
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const { supabaseUrl, supabaseAnonKey, serviceRoleKey } = getFunctionEnv()
    const authorization = request.headers.get('Authorization') || ''
    if (!authorization) return json({ error: 'Authorization is required.' }, 401)
    const userClient = createUserClient(authorization, supabaseUrl, supabaseAnonKey)
    const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData?.user?.id) return json({ error: 'Invalid or expired session.' }, 401)
    const requesterProfile = await getRequesterProfile(adminClient, userData.user.id)
    if (!requesterProfile) return json({ error: 'Unable to determine your staff permissions.' }, 403)
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = normalizeText(payload.action)

    if (action === 'get_payment_settings') {
      const row = await getPaymentSettingsRow(adminClient, requesterProfile.organization_id)
      return json({ settings: maskSettings(row) })
    }
    if (action === 'save_payment_settings') {
      return await savePaymentSettings(adminClient, requesterProfile, payload)
    }
    if (action === 'initiate_online_payment') {
      return await initiateOnlinePayment(adminClient, requesterProfile, payload, supabaseUrl)
    }
    return json({ error: 'Unsupported payment action.' }, 400)
  } catch (error) {
    console.error('[payment-admin]', error)
    return json({ error: (error as Error)?.message || 'Payment request failed.' }, 500)
  }
})
