import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { config, isSupabaseSyncConfigured } from './config.js'
import { db, parseJson, nowIso } from './db.js'
import { getInventoryImportStatus, importInventorySnapshot } from './inventoryRepository.js'
import { getNhiaSummary } from './nhiaRepository.js'
import { importOfflineRecords } from './offlineRecordsRepository.js'

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

const markOfflineRecordSynced = db.prepare(`
  UPDATE offline_records
  SET sync_status = 'synced',
      synced_at = ?,
      last_sync_error = NULL,
      updated_at = ?
  WHERE id = ?
    AND entity_type = ?
`)

const markOfflineRecordFailed = db.prepare(`
  UPDATE offline_records
  SET sync_status = 'failed',
      last_sync_error = ?,
      updated_at = ?
  WHERE id = ?
    AND entity_type = ?
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
    realtime: {
      transport: WebSocket,
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

const stripLocalFields = (record, omit = []) => {
  const omitted = new Set([
    'local_id',
    'sync_status',
    'last_sync_error',
    'synced_at',
    ...omit,
  ])
  return Object.fromEntries(
    Object.entries(record || {}).filter(([, value]) => value !== undefined).filter(([key]) => !omitted.has(key))
  )
}

const syncRecordUpsert = async (supabase, row) => {
  const payload = parseJson(row.payload_json, {})
  const entityType = payload.entity_type || row.entity_type
  const record = payload.record || {}
  const timestamp = nowIso()

  if (!record.id) {
    throw new Error('Offline record is missing an id.')
  }

  const { data, error } = await supabase.rpc('branch_sync_upsert_offline_record', {
    p_sync_token: config.branchSyncToken,
    p_entity_type: entityType,
    p_local_id: record.id,
    p_record: stripLocalFields(record),
  })

  if (error) {
    throw error
  }

  markOfflineRecordSynced.run(timestamp, timestamp, record.id, entityType)
  markOutboxSynced.run(timestamp, timestamp, row.id)
  return {
    localId: record.id,
    entityType,
    remoteId: data?.remote_id || record.id,
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
      } else if (row.event_type === 'record.upsert') {
        await syncRecordUpsert(supabase, row)
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
        markOfflineRecordFailed.run(message, nowIso(), row.entity_id, row.entity_type)
      } else {
        markOfflineRecordFailed.run(message, nowIso(), row.entity_id, row.entity_type)
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
  const offlineRows = db.prepare(`
    SELECT entity_type, sync_status, COUNT(*) AS count
    FROM offline_records
    GROUP BY entity_type, sync_status
    ORDER BY entity_type, sync_status
  `).all()
  const eventRows = db.prepare(`
    SELECT event_type, status, COUNT(*) AS count
    FROM sync_outbox
    GROUP BY event_type, status
    ORDER BY event_type, status
  `).all()
  const failedRecords = db.prepare(`
    SELECT id, entity_type, last_sync_error, updated_at
    FROM offline_records
    WHERE sync_status = 'failed'
    ORDER BY updated_at DESC
    LIMIT 10
  `).all()
  const failedEvents = db.prepare(`
    SELECT id, event_type, entity_type, last_error, updated_at
    FROM sync_outbox
    WHERE status = 'failed'
    ORDER BY updated_at DESC
    LIMIT 10
  `).all()

  const status = rows.reduce(
    (status, row) => {
      status[row.status] = row.count
      status.total += row.count
      return status
    },
    { pending: 0, syncing: 0, failed: 0, synced: 0, total: 0 }
  )
  const recordsByEntity = offlineRows.reduce((summary, row) => {
    if (!summary[row.entity_type]) {
      summary[row.entity_type] = { pending: 0, failed: 0, synced: 0, total: 0 }
    }
    summary[row.entity_type][row.sync_status] = row.count
    summary[row.entity_type].total += row.count
    return summary
  }, {})
  const eventsByType = eventRows.reduce((summary, row) => {
    if (!summary[row.event_type]) {
      summary[row.event_type] = { pending: 0, syncing: 0, failed: 0, synced: 0, total: 0 }
    }
    summary[row.event_type][row.status] = row.count
    summary[row.event_type].total += row.count
    return summary
  }, {})

  return {
    ...status,
    recordsByEntity,
    eventsByType,
    recentFailures: {
      records: failedRecords,
      events: failedEvents,
    },
    inventory: getInventoryImportStatus(),
    nhia: getNhiaSummary(),
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

const selectAll = async (supabase, table, select = '*') => {
  let query = supabase.from(table).select(select)
  if (config.organizationId) {
    query = query.eq('organization_id', config.organizationId)
  }
  const { data, error } = await query.limit(20000)
  if (error) {
    throw error
  }
  return data || []
}

const selectOptionalAll = async (supabase, table, select = '*') => {
  try {
    return await selectAll(supabase, table, select)
  } catch (error) {
    if (['42P01', 'PGRST205'].includes(error?.code)) {
      return []
    }
    throw error
  }
}

export const pullReferenceData = async () => {
  const supabase = createSupabaseClient()
  const result = {
    pulledAt: nowIso(),
    patients: 0,
    suppliers: 0,
    claims: 0,
    nhisDrugs: 0,
    nhisClinicalRules: 0,
    nhisClaims: 0,
    purchases: 0,
  }

  const [patients, suppliers, claims, nhisDrugs, nhisClinicalRules, nhisClaims, purchases] =
    await withSupabaseNetworkContext(() =>
      Promise.all([
        selectAll(supabase, 'patients'),
        selectAll(supabase, 'suppliers'),
        selectAll(supabase, 'claims', '*, claim_items (*)'),
        selectAll(supabase, 'nhis_drugs'),
        selectOptionalAll(supabase, 'nhis_clinical_rules'),
        selectAll(supabase, 'nhis_claims', '*, nhis_claim_medicines (*)'),
        selectAll(supabase, 'purchases', '*, purchase_items (*)'),
      ])
    )

  result.patients = importOfflineRecords('patients', patients).imported
  result.suppliers = importOfflineRecords('suppliers', suppliers).imported
  result.claims = importOfflineRecords('claims', claims).imported
  result.nhisDrugs = importOfflineRecords('nhis_drugs', nhisDrugs).imported
  result.nhisClinicalRules = importOfflineRecords('nhis_clinical_rules', nhisClinicalRules).imported
  result.nhisClaims = importOfflineRecords('nhis_claims', nhisClaims).imported
  result.purchases = importOfflineRecords('purchases', purchases).imported

  return result
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
