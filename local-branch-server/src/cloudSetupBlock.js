// Reads the "setup block" that Branch Sync Setup shows in HealthFlow Cloud (the KEY=value lines an
// administrator copies for one pharmacy machine) and picks out the six values the local server needs
// to connect to the cloud. Everything else in the block (PORT, update settings, comments) is ignored.
//
// This only extracts. The values are then checked and written to .env by saveCloudSyncSettings in
// tlsSettings.js, the same function the app's own "Apply facility connection" button uses, so the
// helper and the app can never disagree about what a valid value is.

export const SETUP_BLOCK_FIELDS = Object.freeze({
  ORGANIZATION_ID: 'organizationId',
  BRANCH_ID: 'branchId',
  BRANCH_SYNC_TOKEN: 'branchSyncToken',
  SUPABASE_URL: 'supabaseUrl',
  SUPABASE_SYNC_KEY: 'supabaseSyncKey',
  NHIA_CONFIG_SECRET_KEY: 'nhiaConfigSecretKey',
})

export class SetupBlockError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SetupBlockError'
  }
}

const PLACEHOLDER = /^<.*>$/

const unquote = (value) => {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

export const parseSetupBlock = (text) => {
  const source = String(text ?? '').replace(/^﻿/, '')
  if (!source.trim()) {
    throw new SetupBlockError(
      'Nothing was found on the clipboard. In HealthFlow Cloud, open Branch Sync Setup, register this computer, press Copy, then run this again.'
    )
  }

  const found = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim().replace(/^export\s+/, '')
    if (!Object.hasOwn(SETUP_BLOCK_FIELDS, key)) continue
    found[key] = unquote(line.slice(separator + 1))
  }

  const missing = []
  const placeholders = []
  const input = {}
  for (const [key, field] of Object.entries(SETUP_BLOCK_FIELDS)) {
    const value = found[key]
    if (value === undefined || value === '') {
      missing.push(key)
    } else if (PLACEHOLDER.test(value)) {
      placeholders.push(key)
    } else {
      input[field] = value
    }
  }

  if (missing.length || placeholders.length) {
    const parts = []
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`)
    if (placeholders.length) {
      parts.push(`still a placeholder in the block: ${placeholders.join(', ')}`)
    }
    throw new SetupBlockError(
      `The clipboard does not hold a complete setup block (${parts.join('; ')}). Copy the whole block again from Branch Sync Setup.`
    )
  }

  return input
}

// What is safe to show on screen or in a log: ids and the cloud address, never a token or key.
export const summarizeSetup = (input) => {
  let host = ''
  try {
    host = new URL(input.supabaseUrl).host
  } catch {
    host = ''
  }
  return {
    organizationId: input.organizationId,
    branchId: input.branchId,
    cloudHost: host,
    branchSyncToken: 'received',
    supabaseSyncKey: 'received',
  }
}
