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
  sqlitePath: path.resolve(process.env.SQLITE_PATH || './data/healthflow-branch.sqlite'),
  syncIntervalSeconds: Math.max(5, toNumber(process.env.SYNC_INTERVAL_SECONDS, 30)),
  inventoryPullIntervalSeconds: Math.max(
    30,
    toNumber(process.env.INVENTORY_PULL_INTERVAL_SECONDS, 300)
  ),
  branchSyncToken: process.env.BRANCH_SYNC_TOKEN || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSyncKey: process.env.SUPABASE_SYNC_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
}

export const assertConfiguredForServer = () => {
  if (!config.branchServerToken || config.branchServerToken.includes('change-this')) {
    throw new Error('Set BRANCH_SERVER_TOKEN to a long random value before starting the server.')
  }
}

export const isSupabaseSyncConfigured = () =>
  Boolean(config.supabaseUrl && config.supabaseSyncKey && config.branchSyncToken)
