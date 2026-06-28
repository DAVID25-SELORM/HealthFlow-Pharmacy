import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(serverDir, '..', '.env') })
dotenv.config()

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toBoolean = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
const isWeakPlaceholder = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return !normalized ||
    normalized.includes('change-me') ||
    normalized.includes('change_this') ||
    normalized.includes('change-this') ||
    normalized.includes('placeholder')
}
const DEFAULT_NHIA_ELIGIBILITY_BASE_URL = 'https://elig.nhia.gov.gh:5000'

const normalizePath = (value, fallback) => {
  const normalized = String(value || fallback || '').trim()
  if (!normalized) {
    return fallback
  }

  return normalized.startsWith('/') ? normalized.replace(/\/+$/, '') || '/' : `/${normalized.replace(/\/+$/, '')}`
}

const resolveClaimBridgeEnabled = () => {
  const configured = String(process.env.CLAIM_BRIDGE_ENABLED || '').trim()
  if (configured) {
    return toBoolean(configured)
  }

  return Boolean(process.env.CLAIMIT_UPSTREAM_BASE_URL)
}

const resolveTrustProxy = () => {
  const value = String(process.env.TRUST_PROXY || '').trim().toLowerCase()
  if (!value || ['0', 'false', 'no', 'off'].includes(value)) return false
  if (['1', 'true', 'yes', 'on', 'loopback'].includes(value)) return 'loopback'
  throw new Error('TRUST_PROXY only supports false or loopback for the local branch server.')
}

export const config = {
  port: toNumber(process.env.PORT, 4780),
  branchServerToken: process.env.BRANCH_SERVER_TOKEN || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  allowNullOrigin: toBoolean(process.env.ALLOW_NULL_ORIGIN),
  allowLanOrigins: toBoolean(process.env.ALLOW_LAN_ORIGINS),
  trustProxy: resolveTrustProxy(),
  branchId: process.env.BRANCH_ID || null,
  organizationId: process.env.ORGANIZATION_ID || null,
  facilityBranding: {
    name: process.env.FACILITY_NAME || '',
    type: process.env.FACILITY_TYPE || '',
    logoUrl: process.env.FACILITY_LOGO_URL || '',
    address: process.env.FACILITY_ADDRESS || '',
    phone: process.env.FACILITY_PHONE || '',
    email: process.env.FACILITY_EMAIL || '',
    website: process.env.FACILITY_WEBSITE || '',
    receiptFooter: process.env.FACILITY_RECEIPT_FOOTER || '',
    reportFooter: process.env.FACILITY_REPORT_FOOTER || '',
    themePrimaryColor: process.env.FACILITY_THEME_PRIMARY_COLOR || '',
    themeSecondaryColor: process.env.FACILITY_THEME_SECONDARY_COLOR || '',
    themeAccentColor: process.env.FACILITY_THEME_ACCENT_COLOR || '',
  },
  sqlitePath: path.resolve(
    process.env.HEALTHFLOW_DB_PATH ||
      process.env.SQLITE_PATH ||
      './data/healthflow-branch.sqlite'
  ),
  syncIntervalSeconds: Math.max(5, toNumber(process.env.SYNC_INTERVAL_SECONDS, 30)),
  inventoryPullIntervalSeconds: Math.max(
    30,
    toNumber(process.env.INVENTORY_PULL_INTERVAL_SECONDS, 300)
  ),
  offlineSessionHours: Math.min(
    24 * 30,
    Math.max(8, toNumber(process.env.OFFLINE_SESSION_HOURS, 24 * 30))
  ),
  rateLimit: {
    enabled: !['0', 'false', 'no', 'off'].includes(
      String(process.env.RATE_LIMIT_ENABLED || 'true').trim().toLowerCase()
    ),
    windowMs: Math.max(1000, toNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000)),
    maxRequests: Math.max(10, toNumber(process.env.RATE_LIMIT_MAX_REQUESTS, 600)),
  },
  branchSyncToken: process.env.BRANCH_SYNC_TOKEN || '',
  nhiaConfigSecretKey: process.env.NHIA_CONFIG_SECRET_KEY || process.env.NHIA_SECRET_KEY || '',
  nhiaFacilityCode: process.env.NHIA_FACILITY_CODE || process.env.FACILITY_CODE || '',
  nhiaProviderId: process.env.NHIA_PROVIDER_ID || process.env.NHIA_PROVIDER_NUMBER || '',
  nhiaCredentialCode: process.env.NHIA_CREDENTIAL_CODE || '',
  nhiaClaimsOfficerName: process.env.NHIA_CLAIMS_OFFICER_NAME || '',
  nhiaAccreditationExpiryDate: process.env.NHIA_ACCREDITATION_EXPIRY_DATE || '',
  nhiaEligibilityBaseUrl: String(
    process.env.NHIA_BASE_URL ||
      process.env.NHIA_ELIGIBILITY_BASE_URL ||
      DEFAULT_NHIA_ELIGIBILITY_BASE_URL
  ).trim().replace(/\/+$/, ''),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSyncKey: process.env.SUPABASE_SYNC_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  updates: {
    manifestUrl: String(process.env.HEALTHFLOW_UPDATE_MANIFEST_URL || '').trim(),
    publicKey: String(process.env.HEALTHFLOW_UPDATE_PUBLIC_KEY || '').trim().replace(/\\n/g, '\n'),
    channel: String(process.env.HEALTHFLOW_UPDATE_CHANNEL || 'stable').trim().toLowerCase(),
    serviceName: String(process.env.HEALTHFLOW_WINDOWS_SERVICE_NAME || 'HealthFlowOfflineServer').trim(),
    checkTimeoutMs: Math.max(3000, toNumber(process.env.HEALTHFLOW_UPDATE_CHECK_TIMEOUT_MS, 15000)),
    autoCheckHours: Math.max(0, toNumber(process.env.HEALTHFLOW_UPDATE_AUTO_CHECK_HOURS, 24)),
    autoInstall: toBoolean(process.env.HEALTHFLOW_UPDATE_AUTO_INSTALL),
    maxPackageBytes: Math.max(
      10 * 1024 * 1024,
      toNumber(process.env.HEALTHFLOW_UPDATE_MAX_PACKAGE_BYTES, 500 * 1024 * 1024)
    ),
  },
  claimBridge: {
    enabled: resolveClaimBridgeEnabled(),
    publicPath: normalizePath(process.env.CLAIM_BRIDGE_PUBLIC_PATH, '/json-api'),
    upstreamBaseUrl: String(process.env.CLAIMIT_UPSTREAM_BASE_URL || '').trim().replace(/\/+$/, ''),
    upstreamCredentialMode: String(process.env.CLAIMIT_UPSTREAM_CREDENTIAL_MODE || '').trim(),
    allowEnvCredentialOverrides: toBoolean(
      process.env.CLAIMIT_ALLOW_ENV_CREDENTIAL_OVERRIDES ||
        process.env.NHIA_ALLOW_ENV_CREDENTIAL_OVERRIDES
    ),
    upstreamMemberLookupPath: normalizePath(process.env.CLAIMIT_UPSTREAM_MEMBER_LOOKUP_PATH, '/api/hmis/genCCC'),
    claimItSubmitBaseUrl: String(
      process.env.CLAIMIT_SUBMIT_BASE_URL ||
        process.env.CLAIMIT_LOCAL_BASE_URL ||
        'http://localhost:31719/json-api'
    ).trim().replace(/\/+$/, ''),
    claimSubmitPath: normalizePath(
      process.env.CLAIMIT_CLAIM_SUBMIT_PATH ||
        process.env.CLAIMIT_UPSTREAM_CLAIM_SUBMIT_PATH,
      '/claims'
    ),
    upstreamCcEndpointPath: normalizePath(
      process.env.CLAIMIT_UPSTREAM_CC_ENDPOINT_PATH ||
        process.env.CLAIMIT_UPSTREAM_CC_CODE_ENDPOINT_PATH,
      ''
    ),
    upstreamApiKey: process.env.NHIA_API_KEY || process.env.CLAIMIT_UPSTREAM_API_KEY || '',
    upstreamApiKeyHeader: String(process.env.NHIA_API_KEY_HEADER || process.env.CLAIMIT_UPSTREAM_API_KEY_HEADER || 'x-nhia-apikey').trim(),
    upstreamApiSecret: process.env.NHIA_API_SECRET || process.env.CLAIMIT_UPSTREAM_API_SECRET || '',
    upstreamApiSecretHeader: String(process.env.NHIA_API_SECRET_HEADER || process.env.CLAIMIT_UPSTREAM_API_SECRET_HEADER || 'x-nhia-apisecret').trim(),
    upstreamBearerToken: process.env.CLAIMIT_UPSTREAM_BEARER_TOKEN || '',
    upstreamUsername: process.env.NHIA_USERNAME || process.env.CLAIMIT_UPSTREAM_USERNAME || '',
    upstreamPassword: process.env.NHIA_PASSWORD || process.env.CLAIMIT_UPSTREAM_PASSWORD || '',
    accessToken: process.env.CLAIM_BRIDGE_TOKEN || '',
    tokenHeader: String(process.env.CLAIM_BRIDGE_TOKEN_HEADER || 'x-claim-bridge-token').trim().toLowerCase(),
    timeoutMs: Math.max(1000, toNumber(process.env.CLAIM_BRIDGE_TIMEOUT_MS, 30000)),
    bodyLimit: process.env.CLAIM_BRIDGE_BODY_LIMIT || '10mb',
  },
  payments: {
    defaultProvider: String(process.env.PAYMENT_DEFAULT_PROVIDER || 'paystack').toLowerCase(),
    publicBaseUrl: (process.env.PAYMENT_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    currency: process.env.PAYMENT_CURRENCY || 'GHS',
    returnUrl: process.env.PAYMENT_RETURN_URL || '',
    hubtel: {
      enabled: String(process.env.HUBTEL_ENABLED || '').toLowerCase() === 'true',
      baseUrl: (process.env.HUBTEL_BASE_URL || 'https://devp-sms03726-api.hubtel.com/v1').replace(/\/+$/, ''),
      clientId: process.env.HUBTEL_CLIENT_ID || '',
      clientSecret: process.env.HUBTEL_CLIENT_SECRET || '',
      requestMoneyPath: process.env.HUBTEL_REQUEST_MONEY_PATH || '/request-money/{mobileNumber}',
      webhookSecret: process.env.HUBTEL_WEBHOOK_SECRET || '',
    },
    paystack: {
      enabled: String(process.env.PAYSTACK_ENABLED || '').toLowerCase() === 'true',
      baseUrl: (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, ''),
      secretKey: process.env.PAYSTACK_SECRET_KEY || '',
      defaultEmail: process.env.PAYSTACK_DEFAULT_EMAIL || '',
    },
  },
  communication: {
    emailEnabled: toBoolean(process.env.COMMUNICATION_EMAIL_ENABLED),
    smsEnabled: toBoolean(process.env.COMMUNICATION_SMS_ENABLED),
    defaultEmailProvider: String(process.env.COMMUNICATION_DEFAULT_EMAIL_PROVIDER || 'smtp').toLowerCase(),
    defaultSmsProvider: String(
      process.env.COMMUNICATION_DEFAULT_SMS_PROVIDER ||
        process.env.SMS_PROVIDER ||
        'arkesel'
    ).toLowerCase(),
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: toNumber(process.env.SMTP_PORT, 587),
      secure: toBoolean(process.env.SMTP_SECURE),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
      fromEmail: process.env.SMTP_FROM_EMAIL || '',
      fromName: process.env.SMTP_FROM_NAME || process.env.FACILITY_NAME || 'HealthFlow',
    },
    sms: {
      provider: String(process.env.SMS_PROVIDER || 'arkesel').toLowerCase(),
      baseUrl: String(process.env.SMS_BASE_URL || process.env.SMS_AKESEL_BASE_URL || process.env.SMS_AKESSEL_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: process.env.SMS_API_KEY || process.env.SMS_AKESEL_API_KEY || process.env.SMS_AKESSEL_API_KEY || '',
      senderId: process.env.SMS_SENDER_ID || process.env.SMS_AKESEL_SENDER_ID || process.env.SMS_AKESSEL_SENDER_ID || process.env.FACILITY_NAME || 'HealthFlow',
      timeoutMs: Math.max(1000, toNumber(process.env.SMS_TIMEOUT_MS, 30000)),
      arkesel: {
        baseUrl: String(process.env.SMS_AKESEL_BASE_URL || process.env.SMS_AKESSEL_BASE_URL || process.env.SMS_BASE_URL || '').replace(/\/+$/, ''),
        apiKey: process.env.SMS_AKESEL_API_KEY || process.env.SMS_AKESSEL_API_KEY || process.env.SMS_API_KEY || '',
        senderId: process.env.SMS_AKESEL_SENDER_ID || process.env.SMS_AKESSEL_SENDER_ID || process.env.SMS_SENDER_ID || process.env.FACILITY_NAME || 'HealthFlow',
      },
      hubtel: {
        baseUrl: String(process.env.SMS_HUBTEL_BASE_URL || '').replace(/\/+$/, ''),
        clientId: process.env.SMS_HUBTEL_CLIENT_ID || '',
        clientSecret: process.env.SMS_HUBTEL_CLIENT_SECRET || '',
        senderId: process.env.SMS_HUBTEL_SENDER_ID || process.env.FACILITY_NAME || 'HealthFlow',
      },
    },
  },
}

export const assertConfiguredForServer = () => {
  if (!config.branchServerToken || config.branchServerToken.includes('change-this')) {
    throw new Error('Set BRANCH_SERVER_TOKEN to a long random value before starting the server.')
  }

  if (config.claimBridge.enabled && !config.claimBridge.upstreamBaseUrl) {
    throw new Error('Set CLAIMIT_UPSTREAM_BASE_URL before enabling the public CLAIM-it bridge.')
  }

  const claimBridgeEnvCredentials = [
    config.claimBridge.upstreamApiKey,
    config.claimBridge.upstreamApiSecret,
    config.claimBridge.upstreamBearerToken,
    config.claimBridge.upstreamUsername,
    config.claimBridge.upstreamPassword,
  ].some((value) => String(value || '').trim())

  if (
    config.claimBridge.enabled &&
    claimBridgeEnvCredentials &&
    !config.claimBridge.allowEnvCredentialOverrides
  ) {
    throw new Error(
      'Remove CLAIM-it/NHIA upstream credentials from .env or set CLAIMIT_ALLOW_ENV_CREDENTIAL_OVERRIDES=true for a dedicated single-facility bridge deployment.'
    )
  }

  if (config.claimBridge.enabled && isWeakPlaceholder(config.claimBridge.accessToken)) {
    throw new Error('Set CLAIM_BRIDGE_TOKEN to a long random value before enabling the public CLAIM-it bridge.')
  }

  if (config.claimBridge.enabled && config.claimBridge.accessToken.length < 32) {
    throw new Error('Set CLAIM_BRIDGE_TOKEN to at least 32 random characters before enabling the public CLAIM-it bridge.')
  }

  if (config.payments.hubtel.enabled && isWeakPlaceholder(config.payments.hubtel.webhookSecret)) {
    throw new Error('Set HUBTEL_WEBHOOK_SECRET to a long random value before enabling Hubtel payments.')
  }

  if (config.communication.emailEnabled && !config.communication.smtp.host) {
    throw new Error('Set SMTP_HOST before enabling email communication.')
  }

  if (config.communication.emailEnabled && !config.communication.smtp.fromEmail) {
    throw new Error('Set SMTP_FROM_EMAIL before enabling email communication.')
  }

  if (config.communication.smsEnabled && !config.communication.sms.baseUrl) {
    throw new Error('Set SMS_BASE_URL before enabling SMS communication.')
  }

  if (config.communication.smsEnabled && !config.communication.sms.apiKey) {
    throw new Error('Set SMS_API_KEY before enabling SMS communication.')
  }
}

export const isSupabaseSyncConfigured = () =>
  Boolean(config.supabaseUrl && config.supabaseSyncKey && config.branchSyncToken)
