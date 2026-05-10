import { createClient } from '@supabase/supabase-js'
import { config, isSupabaseSyncConfigured } from './config.js'
import { db, parseJson, nowIso } from './db.js'
import { getInventoryImportStatus, importInventorySnapshot } from './inventoryRepository.js'

const pendingOutbox = db.prepare(`
  SELECT *
  FROM sync_outbox
  WHERE status IN ('pending', 'failed')
  ORDER BY created_at ASC, rowid ASC
  LIMIT ?
`)

const markOutboxSyncing = db.prepare(`
  UPDATE sync_outbox
  SET status = 'syncing', attempts = attempts + 1, updated_at = ?
  WHERE id = ?
`)

const markOutboxSynced = db.prepare(`
  UPDATE sync_outbox
  SET status = 'synced', last_error = NULL, synced_at = ?, updated_at = ?
  WHERE id = ?
`)

const markOutboxFailed = db.prepare(`
  UPDATE sync_outbox
  SET status = 'failed', last_error = ?, updated_at = ?
  WHERE id = ?
`)

const markSaleSynced = db.prepare(`
  UPDATE sales
  SET sync_status = 'synced',
      remote_sale_id = ?,
      remote_sale_number = ?,
      synced_at = ?,
      last_sync_error = NULL
  WHERE id = ?
`)

const markSaleFailed = db.prepare(`
  UPDATE sales
  SET sync_status = 'failed', last_sync_error = ?
  WHERE id = ?
`)

const markClaimSynced = db.prepare(`
  UPDATE claims
  SET sync_status = 'synced',
      remote_claim_id = ?,
      remote_claim_number = ?,
      synced_at = ?,
      last_sync_error = NULL
  WHERE id = ?
`)

const markClaimFailed = db.prepare(`
  UPDATE claims
  SET sync_status = 'failed', last_sync_error = ?
  WHERE id = ?
`)

const createSupabaseClient = () => {
  if (!isSupabaseSyncConfigured()) {
    throw new Error('Supabase sync is not configured.')
  }

  return createClient(config.supabaseUrl, config.supabaseSyncKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

const getErrorMessage = (error) =>
  [
    error?.message,
    error?.cause?.message,
    error?.cause?.code,
    error?.cause?.errno,
    error?.cause?.syscall,
    error?.cause?.hostname,
  ]
    .filter(Boolean)
    .join(' | ')

const withSupabaseNetworkContext = async (operation) => {
  try {
    return await operation()
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('fetch failed')) {
      throw new Error(`Unable to reach Supabase from this branch server: ${getErrorMessage(error)}`)
    }

    throw error
  }
}

const syncSaleCompleted = async (supabase, row) => {
  const payload = parseJson(row.payload_json)
  const { data, error } = await supabase.rpc('branch_sync_create_sale_transaction', {
    p_sync_token: config.branchSyncToken,
    p_local_sale_id: payload.local_sale_id || row.entity_id,
    sale_payload: payload.sale_payload,
  })

  if (error) {
    throw error
  }

  const timestamp = nowIso()
  markSaleSynced.run(
    data?.sale_id || null,
    data?.sale_number || null,
    timestamp,
    payload.local_sale_id || row.entity_id
  )
  markOutboxSynced.run(timestamp, timestamp, row.id)

  return {
    localId: payload.local_sale_id || row.entity_id,
    remoteId: data?.sale_id || null,
    remoteSaleNumber: data?.sale_number || null,
  }
}

const syncClaimSubmitted = async (supabase, row) => {
  const payload = parseJson(row.payload_json)
  const { data, error } = await supabase.rpc('branch_sync_create_claim_transaction', {
    p_sync_token: config.branchSyncToken,
    p_local_claim_id: payload.local_claim_id || row.entity_id,
    claim_payload: payload.claim_payload,
  })

  if (error) {
    throw error
  }

  const timestamp = nowIso()
  markClaimSynced.run(
    data?.claim_id || null,
    data?.claim_number || null,
    timestamp,
    payload.local_claim_id || row.entity_id
  )
  markOutboxSynced.run(timestamp, timestamp, row.id)

  return {
    localId: payload.local_claim_id || row.entity_id,
    remoteId: data?.claim_id || null,
    remoteClaimNumber: data?.claim_number || null,
  }
}

export const syncPendingOutbox = async ({ limit = 25 } = {}) => {
  const supabase = createSupabaseClient()
  const rows = pendingOutbox.all(Math.min(Math.max(Number(limit) || 25, 1), 100))
  const result = { synced: 0, failed: 0, total: rows.length, errors: [] }

  for (const row of rows) {
    const timestamp = nowIso()
    markOutboxSyncing.run(timestamp, row.id)

    try {
      if (row.event_type === 'sale.completed') {
        await syncSaleCompleted(supabase, row)
        result.synced += 1
      } else if (row.event_type === 'claim.submitted') {
        await syncClaimSubmitted(supabase, row)
        result.synced += 1
      } else {
        throw new Error(`Unsupported sync event type: ${row.event_type}`)
      }
    } catch (error) {
      const message = error.message || 'Sync failed.'
      markOutboxFailed.run(message, nowIso(), row.id)
      if (row.entity_type === 'sales') {
        markSaleFailed.run(message, row.entity_id)
      } else if (row.entity_type === 'claims') {
        markClaimFailed.run(message, row.entity_id)
      }
      result.failed += 1
      result.errors.push({ id: row.id, eventType: row.event_type, message })
    }
  }

  return result
}

export const getSyncStatus = () => {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM sync_outbox
    GROUP BY status
  `).all()

  const status = rows.reduce(
    (status, row) => {
      status[row.status] = row.count
      status.total += row.count
      return status
    },
    { pending: 0, syncing: 0, failed: 0, synced: 0, total: 0 }
  )

  return {
    ...status,
    inventory: getInventoryImportStatus(),
  }
}

export const pullInventorySnapshot = async () => {
  const supabase = createSupabaseClient()
  const { data, error } = await withSupabaseNetworkContext(() =>
    supabase.rpc('branch_sync_get_inventory_snapshot', {
      p_sync_token: config.branchSyncToken,
      p_limit: 20000,
    })
  )

  if (error) {
    throw error
  }

  const result = importInventorySnapshot(data?.drugs || [])
  return {
    ...result,
    branchId: data?.branch_id || null,
    organizationId: data?.organization_id || null,
    pulledAt: data?.pulled_at || null,
  }
}

export const getSupabaseDiagnostics = async () => {
  const startedAt = nowIso()
  const diagnostics = {
    startedAt,
    supabaseUrlConfigured: Boolean(config.supabaseUrl),
    supabaseSyncKeyConfigured: Boolean(config.supabaseSyncKey),
    branchSyncTokenConfigured: Boolean(config.branchSyncToken),
    supabaseUrl: config.supabaseUrl || null,
    reachable: false,
    status: null,
    error: null,
  }

  if (!config.supabaseUrl) {
    diagnostics.error = 'SUPABASE_URL is not configured.'
    return diagnostics
  }

  try {
    const response = await fetch(`${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/`, {
      headers: {
        apikey: config.supabaseSyncKey,
        Authorization: `Bearer ${config.supabaseSyncKey}`,
      },
    })
    diagnostics.reachable = true
    diagnostics.status = response.status
  } catch (error) {
    diagnostics.error = getErrorMessage(error) || 'Unable to reach Supabase.'
  }

  return diagnostics
}
