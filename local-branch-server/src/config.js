import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'

dotenv.config()

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toBoolean = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())

const normalizePath = (value, fallback) => {
  const normalized = String(value || fallback || '').trim()
  if (!normalized) {
    return fallback
  }

  return normalized.startsWith('/') ? normalized.replace(/\/+$/, '') || '/' : `/${normalized.replace(/\/+$/, '')}`
}

export const config = {
  port: toNumber(process.env.PORT, 4780),
  branchServerToken: process.env.BRANCH_SERVER_TOKEN || '',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  branchId: process.env.BRANCH_ID || null,
  organizationId: process.env.ORGANIZATION_ID || null,
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
  branchSyncToken: process.env.BRANCH_SYNC_TOKEN || '',
  nhiaConfigSecretKey: process.env.NHIA_CONFIG_SECRET_KEY || process.env.NHIA_SECRET_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSyncKey: process.env.SUPABASE_SYNC_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  claimBridge: {
    enabled: toBoolean(process.env.CLAIM_BRIDGE_ENABLED) || Boolean(process.env.CLAIMIT_UPSTREAM_BASE_URL),
    publicPath: normalizePath(process.env.CLAIM_BRIDGE_PUBLIC_PATH, '/json-api'),
    upstreamBaseUrl: String(process.env.CLAIMIT_UPSTREAM_BASE_URL || '').trim().replace(/\/+$/, ''),
    upstreamApiKey: process.env.CLAIMIT_UPSTREAM_API_KEY || '',
    upstreamApiKeyHeader: String(process.env.CLAIMIT_UPSTREAM_API_KEY_HEADER || 'x-api-key').trim(),
    upstreamApiSecret: process.env.CLAIMIT_UPSTREAM_API_SECRET || '',
    upstreamApiSecretHeader: String(process.env.CLAIMIT_UPSTREAM_API_SECRET_HEADER || 'x-api-secret').trim(),
    upstreamBearerToken: process.env.CLAIMIT_UPSTREAM_BEARER_TOKEN || '',
    upstreamUsername: process.env.CLAIMIT_UPSTREAM_USERNAME || '',
    upstreamPassword: process.env.CLAIMIT_UPSTREAM_PASSWORD || '',
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
}

export const assertConfiguredForServer = () => {
  if (!config.branchServerToken || config.branchServerToken.includes('change-this')) {
    throw new Error('Set BRANCH_SERVER_TOKEN to a long random value before starting the server.')
  }

  if (config.claimBridge.enabled && !config.claimBridge.upstreamBaseUrl) {
    throw new Error('Set CLAIMIT_UPSTREAM_BASE_URL before enabling the public CLAIM-it bridge.')
  }

  if (config.claimBridge.enabled && process.env.NODE_ENV === 'production' && !config.claimBridge.accessToken) {
    throw new Error('Set CLAIM_BRIDGE_TOKEN before running the public CLAIM-it bridge in production.')
  }
}

export const isSupabaseSyncConfigured = () =>
  Boolean(config.supabaseUrl && config.supabaseSyncKey && config.branchSyncToken)
