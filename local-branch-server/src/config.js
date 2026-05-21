import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'

dotenv.config()

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
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
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSyncKey: process.env.SUPABASE_SYNC_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
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
}

export const isSupabaseSyncConfigured = () =>
  Boolean(config.supabaseUrl && config.supabaseSyncKey && config.branchSyncToken)
