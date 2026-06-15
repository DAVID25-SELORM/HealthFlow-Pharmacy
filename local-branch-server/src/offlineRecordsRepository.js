import { createId, db, json, nowIso, parseJson } from './db.js'
import { config } from './config.js'

// Maximum rows a single offline read may return. Raised from 5000 so reports/
// exports over large claim volumes are not silently truncated. SQLite reads at
// this size stay sub-second (benchmarked ~250ms for a full 100k-row scan).
const MAX_OFFLINE_READ_LIMIT = 100000

const ALLOWED_ENTITIES = new Set([
  'patients',
  'claims',
  'nhis_drugs',
  'nhis_clinical_rules',
  'nhis_claims',
  'suppliers',
  'purchases',
])

const normalizeEntityType = (entityType) => {
  const normalized = String(entityType || '').trim()
  if (!ALLOWED_ENTITIES.has(normalized)) {
    throw new Error(`Unsupported offline entity type: ${entityType}`)
  }
  return normalized
}

const insertRecord = db.prepare(`
  INSERT INTO offline_records (
    id, entity_type, data_json, sync_status, created_at, updated_at
  )
  VALUES (
    @id, @entityType, @dataJson, 'pending', @createdAt, @updatedAt
  )
`)

const upsertImportedRecord = db.prepare(`
  INSERT INTO offline_records (
    id, entity_type, data_json, sync_status, created_at, updated_at, synced_at
  )
  VALUES (
    @id, @entityType, @dataJson, 'synced', @createdAt, @updatedAt, @syncedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    data_json = CASE
      WHEN offline_records.sync_status = 'pending' THEN offline_records.data_json
      ELSE excluded.data_json
    END,
    sync_status = CASE
      WHEN offline_records.sync_status = 'pending' THEN offline_records.sync_status
      ELSE 'synced'
    END,
    updated_at = CASE
      WHEN offline_records.sync_status = 'pending' THEN offline_records.updated_at
      ELSE excluded.updated_at
    END,
    synced_at = CASE
      WHEN offline_records.sync_status = 'pending' THEN offline_records.synced_at
      ELSE excluded.synced_at
    END
`)

const updateRecord = db.prepare(`
  UPDATE offline_records
  SET data_json = @dataJson,
      sync_status = 'pending',
      last_sync_error = NULL,
      updated_at = @updatedAt
  WHERE id = @id
    AND entity_type = @entityType
`)

const deleteRecord = db.prepare(`
  DELETE FROM offline_records
  WHERE id = ?
    AND entity_type = ?
`)

const deletePendingRecordOutbox = db.prepare(`
  DELETE FROM sync_outbox
  WHERE entity_id = ?
    AND entity_type = ?
    AND event_type = 'record.upsert'
    AND status IN ('pending', 'failed')
`)

const insertOutbox = db.prepare(`
  INSERT INTO sync_outbox (
    id, event_type, entity_type, entity_id, payload_json, status, created_at, updated_at
  )
  VALUES (
    @id, @eventType, @entityType, @entityId, @payloadJson, 'pending', @createdAt, @updatedAt
  )
`)

// ✅ OFFLINE-FIRST PATCH START
const insertSyncEvent = db.prepare(`
  INSERT INTO sync_events (
    id, event_type, entity_type, entity_id, idempotency_key, payload_json,
    pending_sync, status, created_at, updated_at
  )
  VALUES (
    @id, @eventType, @entityType, @entityId, @idempotencyKey, @payloadJson,
    1, 'pending', @createdAt, @updatedAt
  )
  ON CONFLICT(idempotency_key) DO UPDATE SET
    payload_json = excluded.payload_json,
    pending_sync = 1,
    status = 'pending',
    updated_at = excluded.updated_at
`)

const insertClaimStatusQueue = db.prepare(`
  INSERT INTO claim_status_queue (
    id, claim_id, status, payload_json, pending_sync, idempotency_key, created_at, updated_at
  )
  VALUES (
    @id, @claimId, @status, @payloadJson, 1, @idempotencyKey, @createdAt, @updatedAt
  )
  ON CONFLICT(idempotency_key) DO UPDATE SET
    status = excluded.status,
    payload_json = excluded.payload_json,
    pending_sync = 1,
    updated_at = excluded.updated_at
`)

const upsertClaimRow = db.prepare(`
  INSERT INTO claims (
    id, claim_number, patient_id, patient_name, insurance_provider, insurance_id,
    service_date, total_amount, claim_status, prescription_url, notes,
    organization_id, branch_id, submitted_at, created_at, sync_status
  )
  VALUES (
    @id, @claimNumber, @patientId, @patientName, @insuranceProvider, @insuranceId,
    @serviceDate, @totalAmount, @claimStatus, @prescriptionUrl, @notes,
    @organizationId, @branchId, @submittedAt, @createdAt, @syncStatus
  )
  ON CONFLICT(id) DO UPDATE SET
    claim_number = excluded.claim_number,
    patient_id = excluded.patient_id,
    patient_name = excluded.patient_name,
    insurance_provider = excluded.insurance_provider,
    insurance_id = excluded.insurance_id,
    service_date = excluded.service_date,
    total_amount = excluded.total_amount,
    claim_status = excluded.claim_status,
    prescription_url = excluded.prescription_url,
    notes = excluded.notes,
    organization_id = excluded.organization_id,
    branch_id = excluded.branch_id,
    submitted_at = excluded.submitted_at,
    sync_status = excluded.sync_status
`)

const deleteClaimItems = db.prepare('DELETE FROM claim_items WHERE claim_id = ?')
const insertClaimItem = db.prepare(`
  INSERT INTO claim_items (
    id, claim_id, drug_id, drug_name, quantity, unit_price, total_price, created_at
  )
  VALUES (
    @id, @claimId, @drugId, @drugName, @quantity, @unitPrice, @totalPrice, @createdAt
  )
`)
// ✅ OFFLINE-FIRST PATCH END

const getRecordStatement = db.prepare(`
  SELECT *
  FROM offline_records
  WHERE entity_type = ?
    AND id = ?
`)

const listRecordsStatement = db.prepare(`
  SELECT *
  FROM offline_records
  WHERE entity_type = ?
  ORDER BY updated_at DESC, created_at DESC
  LIMIT ?
`)

const listPatientRecordsStatement = db.prepare(`
  SELECT r.*
  FROM offline_records r
  JOIN patients p ON p.id = r.id
  WHERE r.entity_type = 'patients'
  ORDER BY p.updated_at DESC, r.updated_at DESC
  LIMIT ?
`)

const upsertPatientIndex = db.prepare(`
  INSERT INTO patients (
    id, full_name, surname, other_names, phone, email, insurance_provider,
    insurance_id, nhis_member_no, nhis_hin, member_no, hin, updated_at, sync_status
  )
  VALUES (
    @id, @fullName, @surname, @otherNames, @phone, @email, @insuranceProvider,
    @insuranceId, @nhisMemberNo, @nhisHin, @memberNo, @hin, @updatedAt, @syncStatus
  )
  ON CONFLICT(id) DO UPDATE SET
    full_name = excluded.full_name,
    surname = excluded.surname,
    other_names = excluded.other_names,
    phone = excluded.phone,
    email = excluded.email,
    insurance_provider = excluded.insurance_provider,
    insurance_id = excluded.insurance_id,
    nhis_member_no = excluded.nhis_member_no,
    nhis_hin = excluded.nhis_hin,
    member_no = excluded.member_no,
    hin = excluded.hin,
    updated_at = excluded.updated_at,
    sync_status = excluded.sync_status
`)

const deletePatientSearchTokens = db.prepare(`DELETE FROM patient_search_tokens WHERE patient_id = ?`)
const insertPatientSearchToken = db.prepare(`
  INSERT OR IGNORE INTO patient_search_tokens (patient_id, token, created_at)
  VALUES (@patientId, @token, @createdAt)
`)
const countPatientIndexRows = db.prepare(`SELECT COUNT(*) AS count FROM patients`)
const countPatientSearchTokenRows = db.prepare(`SELECT COUNT(*) AS count FROM patient_search_tokens`)
const countOfflinePatientRows = db.prepare(
  `SELECT COUNT(*) AS count FROM offline_records WHERE entity_type = 'patients'`
)
const allOfflinePatientRows = db.prepare(`
  SELECT *
  FROM offline_records
  WHERE entity_type = 'patients'
`)

const recordToObject = (row) => {
  const data = parseJson(row.data_json, {})
  return {
    ...data,
    id: row.id,
    local_id: row.id,
    sync_status: row.sync_status,
    last_sync_error: row.last_sync_error,
    created_at: data.created_at || row.created_at,
    updated_at: data.updated_at || row.updated_at,
  }
}

const textIncludes = (value, term) => String(value || '').toLowerCase().includes(term)

const normalizeSearchTerm = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')

const compactLookup = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

const extractSearchTokens = (values = []) => {
  const tokens = new Set()
  for (const value of values) {
    const normalized = normalizeSearchTerm(value)
    normalized
      .split(' ')
      .filter(Boolean)
      .forEach((token) => tokens.add(token))

    const compact = compactLookup(value)
    if (compact) {
      tokens.add(compact)
    }
  }
  return [...tokens]
}

const getPatientFullName = (record = {}) => {
  const explicitName = record.full_name || record.patient_name || record.name
  if (explicitName) {
    return explicitName
  }
  return [record.surname, record.other_names].filter(Boolean).join(' ').trim() || 'Unnamed patient'
}

const patientSearchValues = (record = {}) => [
  getPatientFullName(record),
  record.surname,
  record.other_names,
  record.phone,
  record.email,
  record.insurance_provider,
  record.insurance_id,
  record.nhis_member_no,
  record.nhis_hin,
  record.member_no,
  record.hin,
]

const indexPatientRecord = (record = {}, syncStatus = 'synced') => {
  if (!record?.id) {
    return
  }

  const timestamp = record.updated_at || nowIso()
  upsertPatientIndex.run({
    id: record.id,
    fullName: getPatientFullName(record),
    surname: record.surname || null,
    otherNames: record.other_names || null,
    phone: record.phone || null,
    email: record.email || null,
    insuranceProvider: record.insurance_provider || null,
    insuranceId: record.insurance_id || null,
    nhisMemberNo: record.nhis_member_no || null,
    nhisHin: record.nhis_hin || null,
    memberNo: record.member_no || null,
    hin: record.hin || null,
    updatedAt: timestamp,
    syncStatus,
  })

  deletePatientSearchTokens.run(record.id)
  for (const token of extractSearchTokens(patientSearchValues(record))) {
    insertPatientSearchToken.run({
      patientId: record.id,
      token,
      createdAt: timestamp,
    })
  }
}

const matchesFilters = (record, filters = {}) => {
  const status = String(filters.status || '').trim()
  if (status && status !== 'all' && ![record.status, record.claim_status, record.sync_status].includes(status)) {
    return false
  }

  if (filters.month) {
    const month = String(filters.month)
    const monthValue = record.submission_month || String(record.service_date_from || record.created_at || '').slice(0, 7)
    if (monthValue !== month) {
      return false
    }
  }

  if (filters.fromDate || filters.toDate) {
    const serviceDate = String(record.service_date_from || record.serviceDate || record.created_at || '').slice(0, 10)
    if (!serviceDate) {
      return false
    }
    if (filters.fromDate && serviceDate < String(filters.fromDate)) {
      return false
    }
    if (filters.toDate && serviceDate > String(filters.toDate)) {
      return false
    }
  }

  if (filters.supplierId && record.supplier_id !== filters.supplierId) {
    return false
  }

  if (filters.id && record.id !== filters.id) {
    return false
  }

  const term = String(filters.searchTerm || filters.search || '').trim().toLowerCase()
  if (!term) {
    return true
  }

  return [
    record.full_name,
    record.phone,
    record.email,
    record.insurance_provider,
    record.insurance_id,
    record.nhis_member_no,
    record.nhis_hin,
    record.patient_name,
    record.claim_number,
    record.member_no,
    record.hin,
    record.surname,
    record.other_names,
    record.code,
    record.description,
    record.generic_name,
    record.name,
    record.supplier_name,
    record.invoice_number,
    record.purchase_number,
  ].some((value) => textIncludes(value, term))
}

const enrichRecord = (entityType, payload) => {
  const timestamp = nowIso()
  const id = payload.id || payload.local_id || createId()
  const base = {
    ...payload,
    id,
    organization_id: payload.organization_id || config.organizationId,
    branch_id: payload.branch_id || config.branchId,
    created_at: payload.created_at || timestamp,
    updated_at: timestamp,
  }

  if (entityType === 'claims') {
    return {
      claim_number: payload.claim_number || `BCL-${timestamp.slice(2, 10).replace(/-/g, '')}-${id.slice(0, 4).toUpperCase()}`,
      claim_status: payload.claim_status || payload.status || 'pending',
      submitted_at: payload.submitted_at || timestamp,
      ...base,
    }
  }

  if (entityType === 'nhis_claims') {
    return {
      claim_number: payload.claim_number || `NHIS-OFF-${timestamp.slice(2, 10).replace(/-/g, '')}-${id.slice(0, 4).toUpperCase()}`,
      status: payload.status || 'served',
      submission_month: payload.submission_month || String(payload.service_date_from || timestamp).slice(0, 7),
      ...base,
    }
  }

  if (entityType === 'purchases') {
    return {
      purchase_number: payload.purchase_number || `PO-OFF-${timestamp.slice(2, 10).replace(/-/g, '')}-${id.slice(0, 4).toUpperCase()}`,
      status: payload.status || 'draft',
      purchase_date: payload.purchase_date || timestamp.slice(0, 10),
      ...base,
    }
  }

  return base
}

// ✅ OFFLINE-FIRST PATCH START
const indexClaimRecord = (record = {}, syncStatus = 'pending') => {
  if (!record?.id) {
    return
  }

  const timestamp = record.updated_at || nowIso()
  const claimItems = Array.isArray(record.claim_items)
    ? record.claim_items
    : Array.isArray(record.items)
      ? record.items
      : []

  upsertClaimRow.run({
    id: record.id,
    claimNumber: record.claim_number || `BCL-${timestamp.slice(2, 10).replace(/-/g, '')}-${record.id.slice(0, 4).toUpperCase()}`,
    patientId: record.patient_id || null,
    patientName: record.patient_name || 'Offline patient',
    insuranceProvider: record.insurance_provider || 'Insurance',
    insuranceId: record.insurance_id || 'Offline',
    serviceDate: record.service_date || timestamp.slice(0, 10),
    totalAmount: Number(record.total_amount || 0),
    claimStatus: record.claim_status || record.status || 'pending',
    prescriptionUrl: record.prescription_url || null,
    notes: record.notes || null,
    organizationId: record.organization_id || config.organizationId,
    branchId: record.branch_id || config.branchId,
    submittedAt: record.submitted_at || timestamp,
    createdAt: record.created_at || timestamp,
    syncStatus,
  })

  deleteClaimItems.run(record.id)
  for (const item of claimItems) {
    const quantity = Number(item.quantity || 0)
    const unitPrice = Number(item.unit_price ?? item.price ?? 0)
    insertClaimItem.run({
      id: item.id || createId(),
      claimId: record.id,
      drugId: item.drug_id || item.drugId || '',
      drugName: item.drug_name || item.name || 'Claim item',
      quantity,
      unitPrice,
      totalPrice: Number(item.total_price ?? item.totalPrice ?? quantity * unitPrice),
      createdAt: item.created_at || timestamp,
    })
  }
}
// ✅ OFFLINE-FIRST PATCH END

const listPatientRecords = (filters = {}) => {
  const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), MAX_OFFLINE_READ_LIMIT)
  const nonSearchFilters = { ...filters, search: '', searchTerm: '' }

  if (filters.id) {
    const row = getRecordStatement.get('patients', filters.id)
    return row ? [recordToObject(row)].filter((record) => matchesFilters(record, nonSearchFilters)) : []
  }

  const term = normalizeSearchTerm(filters.searchTerm || filters.search || '')
  if (!term) {
    return listPatientRecordsStatement
      .all(limit)
      .map(recordToObject)
      .filter((record) => matchesFilters(record, nonSearchFilters))
  }

  const searchTokens = extractSearchTokens([term])
  const compactTerm = compactLookup(term)
  if (compactTerm && !searchTokens.includes(compactTerm)) {
    searchTokens.push(compactTerm)
  }

  if (!searchTokens.length) {
    return []
  }

  const placeholders = searchTokens.map(() => '?').join(',')
  const tokenPrefixes = searchTokens.map((token) => `${token}%`)
  const prefixConditions = tokenPrefixes.map(() => 'pst.token LIKE ?').join(' OR ')

  return db
    .prepare(`
      SELECT DISTINCT r.*
      FROM offline_records r
      JOIN patients p ON p.id = r.id
      JOIN patient_search_tokens pst ON pst.patient_id = p.id
      WHERE r.entity_type = 'patients'
        AND (
          pst.token IN (${placeholders})
          OR ${prefixConditions}
        )
      ORDER BY p.full_name ASC, p.updated_at DESC
      LIMIT ?
    `)
    .all(...searchTokens, ...tokenPrefixes, limit)
    .map(recordToObject)
    .filter((record) => matchesFilters(record, nonSearchFilters))
}

export const listOfflineRecords = (entityType, filters = {}) => {
  const normalizedEntity = normalizeEntityType(entityType)
  if (normalizedEntity === 'patients') {
    return listPatientRecords(filters)
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), MAX_OFFLINE_READ_LIMIT)
  return listRecordsStatement
    .all(normalizedEntity, limit)
    .map(recordToObject)
    .filter((record) => matchesFilters(record, filters))
}

export const getOfflineRecord = (entityType, id) => {
  const normalizedEntity = normalizeEntityType(entityType)
  const row = getRecordStatement.get(normalizedEntity, id)
  return row ? recordToObject(row) : null
}

export const saveOfflineRecord = db.transaction((entityType, payload = {}) => {
  const normalizedEntity = normalizeEntityType(entityType)
  const timestamp = nowIso()
  const record = enrichRecord(normalizedEntity, payload)
  const existing = getRecordStatement.get(normalizedEntity, record.id)
  const dataJson = json(record)

  if (existing) {
    updateRecord.run({
      id: record.id,
      entityType: normalizedEntity,
      dataJson,
      updatedAt: timestamp,
    })
  } else {
    insertRecord.run({
      id: record.id,
      entityType: normalizedEntity,
      dataJson,
      createdAt: record.created_at || timestamp,
      updatedAt: timestamp,
    })
  }

  insertOutbox.run({
    id: createId(),
    eventType: 'record.upsert',
    entityType: normalizedEntity,
    entityId: record.id,
    payloadJson: json({
      entity_type: normalizedEntity,
      local_id: record.id,
      record,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  // ✅ OFFLINE-FIRST PATCH START
  const syncPayload = {
    entity_type: normalizedEntity,
    local_id: record.id,
    record,
  }
  insertSyncEvent.run({
    id: createId(),
    eventType: 'record.upsert',
    entityType: normalizedEntity,
    entityId: record.id,
    idempotencyKey: `${normalizedEntity}:${record.id}:upsert`,
    payloadJson: json(syncPayload),
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  if (normalizedEntity === 'claims') {
    indexClaimRecord(record, 'pending')
    insertClaimStatusQueue.run({
      id: createId(),
      claimId: record.id,
      status: record.claim_status || record.status || 'pending',
      payloadJson: json(record),
      idempotencyKey: `claims:${record.id}:status:${record.claim_status || record.status || 'pending'}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }
  // ✅ OFFLINE-FIRST PATCH END

  if (normalizedEntity === 'patients') {
    indexPatientRecord(record, 'pending')
  }

  return getOfflineRecord(normalizedEntity, record.id)
})

export const deleteOfflineRecord = db.transaction((entityType, id) => {
  const normalizedEntity = normalizeEntityType(entityType)
  const existing = getOfflineRecord(normalizedEntity, id)
  if (!existing) return null

  const timestamp = nowIso()
  deletePendingRecordOutbox.run(id, normalizedEntity)
  deleteRecord.run(id, normalizedEntity)
  insertOutbox.run({
    id: createId(),
    eventType: 'record.delete',
    entityType: normalizedEntity,
    entityId: id,
    payloadJson: json({
      entity_type: normalizedEntity,
      local_id: id,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  return existing
})

export const importOfflineRecords = db.transaction((entityType, records = []) => {
  const normalizedEntity = normalizeEntityType(entityType)
  const timestamp = nowIso()
  const rows = Array.isArray(records) ? records : []

  for (const row of rows) {
    if (!row?.id) {
      continue
    }

    upsertImportedRecord.run({
      id: row.id,
      entityType: normalizedEntity,
      dataJson: json({
        ...row,
        sync_status: 'synced',
      }),
      createdAt: row.created_at || timestamp,
      updatedAt: row.updated_at || timestamp,
      syncedAt: timestamp,
    })

    if (normalizedEntity === 'patients') {
      const storedPatientRow = getRecordStatement.get(normalizedEntity, row.id)
      if (storedPatientRow) {
        const storedPatient = recordToObject(storedPatientRow)
        indexPatientRecord(storedPatient, storedPatient.sync_status || 'synced')
      }
    }

    if (normalizedEntity === 'claims') {
      const storedClaimRow = getRecordStatement.get(normalizedEntity, row.id)
      if (storedClaimRow) {
        const storedClaim = recordToObject(storedClaimRow)
        indexClaimRecord(storedClaim, storedClaim.sync_status || 'synced')
      }
    }
  }

  return {
    entityType: normalizedEntity,
    imported: rows.filter((row) => row?.id).length,
    importedAt: timestamp,
  }
})

const rebuildPatientIndexFromOfflineRecords = db.transaction(() => {
  for (const row of allOfflinePatientRows.all()) {
    const patient = recordToObject(row)
    indexPatientRecord(patient, patient.sync_status || 'synced')
  }
})

const offlinePatientCount = countOfflinePatientRows.get().count
if (
  offlinePatientCount > 0 &&
  (countPatientIndexRows.get().count < offlinePatientCount ||
    countPatientSearchTokenRows.get().count < offlinePatientCount)
) {
  rebuildPatientIndexFromOfflineRecords()
}
