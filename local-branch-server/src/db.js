import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

const schemaPath = new URL('./schema.sql', import.meta.url)

// ✅ SQLITE CORRUPTION FIX START
const timestampForFile = () => {
  const value = new Date()
  const pad = (part) => String(part).padStart(2, '0')
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    '-',
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
  ].join('')
}

const ensureDatabaseDirectory = () => {
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true })
}

const applyHardeningPragmas = (database) => {
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  database.pragma('temp_store = MEMORY')
}

const runIntegrityCheck = (database) => {
  const result = database.prepare('PRAGMA integrity_check').pluck().get()
  if (result !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${result}`)
  }
}

const renameIfExists = (source, destination) => {
  if (fs.existsSync(source)) {
    fs.renameSync(source, destination)
  }
}

const quarantineCorruptDatabase = () => {
  const parsed = path.parse(config.sqlitePath)
  const suffix = timestampForFile()
  const corruptPath = path.join(parsed.dir, `${parsed.name}-corrupt-${suffix}${parsed.ext}`)

  renameIfExists(config.sqlitePath, corruptPath)
  renameIfExists(`${config.sqlitePath}-wal`, `${corruptPath}-wal`)
  renameIfExists(`${config.sqlitePath}-shm`, `${corruptPath}-shm`)

  console.error(
    `SQLite database was corrupt and has been preserved as ${corruptPath}. A fresh database will be created.`
  )
}

const isRecoverableDatabaseError = (error) => {
  const message = String(error?.message || '').toLowerCase()
  return (
    error?.code === 'SQLITE_CORRUPT' ||
    message.includes('database disk image is malformed') ||
    message.includes('integrity_check failed')
  )
}

const initializeSchema = (database) => {
  database.exec(fs.readFileSync(schemaPath, 'utf8'))
}

const openDatabase = () => {
  ensureDatabaseDirectory()
  const database = new Database(config.sqlitePath)
  try {
    applyHardeningPragmas(database)
    runIntegrityCheck(database)
    initializeSchema(database)
    return database
  } catch (error) {
    try {
      database.close()
    } catch {
      // Ignore close errors while bubbling the startup failure.
    }
    throw error
  }
}

const openHealthyDatabase = () => {
  try {
    return openDatabase()
  } catch (error) {
    if (!isRecoverableDatabaseError(error)) {
      throw error
    }

    console.error('SQLite startup health check failed:', error)
    try {
      const failedDatabase = new Database(config.sqlitePath)
      failedDatabase.close()
    } catch {
      // Ignore close errors while recovering a malformed database.
    }
    quarantineCorruptDatabase()
    const database = openDatabase()
    console.error(`SQLite recovery complete. Fresh database created at ${config.sqlitePath}.`)
    return database
  }
}

export const db = openHealthyDatabase()

export const backupDatabase = (label = 'backup') => {
  const backupDir = path.join(path.dirname(config.sqlitePath), 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const parsed = path.parse(config.sqlitePath)
  const backupPath = path.join(
    backupDir,
    `${parsed.name}-${label}-${timestampForFile()}${parsed.ext}`
  )
  db.pragma('wal_checkpoint(FULL)')
  fs.copyFileSync(config.sqlitePath, backupPath)
  return backupPath
}

export const closeDatabase = () => {
  if (db.open) {
    db.close()
  }
}
// ✅ SQLITE CORRUPTION FIX END

const ensureColumn = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('drugs', 'brand_name', 'TEXT')
ensureColumn('drugs', 'generic_name', 'TEXT')
ensureColumn('drugs', 'barcode', 'TEXT')
ensureColumn('drugs', 'nhis_unit', 'TEXT')
// ✅ NHIS PHARMACY LEVEL PATCH START
ensureColumn('drugs', 'medicine_access_level', 'TEXT')
ensureColumn('drugs', 'required_pharmacy_level', 'TEXT')
// ✅ NHIS PHARMACY LEVEL PATCH END
db.exec('CREATE INDEX IF NOT EXISTS idx_drugs_barcode ON drugs(barcode)')
ensureColumn('patients', 'surname', 'TEXT')
ensureColumn('patients', 'other_names', 'TEXT')
ensureColumn('patients', 'nhis_member_no', 'TEXT')
ensureColumn('patients', 'nhis_hin', 'TEXT')
ensureColumn('patients', 'member_no', 'TEXT')
ensureColumn('patients', 'hin', 'TEXT')
db.exec('CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name)')
db.exec('CREATE INDEX IF NOT EXISTS idx_patients_updated ON patients(updated_at)')
db.exec('CREATE INDEX IF NOT EXISTS idx_patients_insurance_id ON patients(insurance_id)')
db.exec(`
  CREATE TABLE IF NOT EXISTS patient_search_tokens (
    patient_id TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (patient_id, token)
  )
`)
db.exec('CREATE INDEX IF NOT EXISTS idx_patient_search_tokens_token ON patient_search_tokens(token)')
db.exec('CREATE INDEX IF NOT EXISTS idx_patient_search_tokens_patient ON patient_search_tokens(patient_id)')
ensureColumn('drugs', 'sale_on_return', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('sales', 'payment_status', "TEXT NOT NULL DEFAULT 'completed'")
ensureColumn('sales', 'amount_paid', 'REAL')
ensureColumn('sales', 'change_given', 'REAL')
ensureColumn('nhia_settings', 'nhis_member_digits', 'INTEGER NOT NULL DEFAULT 8')
ensureColumn('nhia_settings', 'ghana_card_digits', 'INTEGER NOT NULL DEFAULT 10')
ensureColumn('nhia_settings', 'cc_code_endpoint_path', 'TEXT')
ensureColumn('nhia_settings', 'scheme_name', "TEXT NOT NULL DEFAULT 'National Health Insurance'")
ensureColumn('nhia_settings', 'provider_type_description', 'TEXT')
ensureColumn('nhia_settings', 'provider_class_level', 'TEXT')
// ✅ NHIA CONFIG PATCH START
ensureColumn('nhia_settings', 'facility_type', 'TEXT')
ensureColumn('nhia_settings', 'pharmacy_facility_level', 'TEXT')
ensureColumn('nhia_settings', 'provider_level_code', 'TEXT')
ensureColumn('nhia_settings', 'credential_code', 'TEXT')
ensureColumn('nhia_settings', 'license_number', 'TEXT')
ensureColumn('nhia_settings', 'accreditation_expiry_date', 'TEXT')
// ✅ NHIA API ARCHITECTURE PATCH START
ensureColumn('nhia_settings', 'integration_mode', "TEXT NOT NULL DEFAULT 'claimit_export'")
ensureColumn('nhia_settings', 'connection_profile', "TEXT NOT NULL DEFAULT 'local_server'")
ensureColumn('nhia_settings', 'validation_mode', "TEXT NOT NULL DEFAULT 'validate_before_submit'")
ensureColumn('nhia_settings', 'claim_control_mode', "TEXT NOT NULL DEFAULT 'manual'")
ensureColumn('nhia_settings', 'sandbox_base_url', 'TEXT')
ensureColumn('nhia_settings', 'production_base_url', 'TEXT')
ensureColumn('nhia_settings', 'claim_validation_endpoint_path', 'TEXT')
ensureColumn('nhia_settings', 'cc_endpoint_path', 'TEXT')
ensureColumn('nhia_settings', 'claim_status_endpoint_path', 'TEXT')
ensureColumn('nhia_settings', 'member_lookup_endpoint_path', 'TEXT')
// ✅ NHIA API ARCHITECTURE PATCH END
// ✅ NHIA CONFIG PATCH END
// ✅ NHIS PHARMACY LEVEL PATCH START
ensureColumn('nhia_settings', 'pharmacy_level', 'TEXT')
// ✅ NHIS PHARMACY LEVEL PATCH END
ensureColumn('nhia_settings', 'claims_officer_name', 'TEXT')
ensureColumn('nhia_settings', 'admission_payment_option', "TEXT NOT NULL DEFAULT 'nhis_pays_admission'")
ensureColumn('nhia_settings', 'claimit_validation_enabled', 'INTEGER NOT NULL DEFAULT 1')
ensureColumn('nhia_settings', 'claims_officer_signature_url', 'TEXT')
const ensureNhiaConfigurationColumn = (column, definition) => ensureColumn('nhia_configuration', column, definition)
;[
  ['organization_id', 'TEXT'],
  ['branch_id', 'TEXT'],
  ['mode', "TEXT NOT NULL DEFAULT 'OFFLINE_LOCAL'"],
  ['provider_id', 'TEXT'],
  ['facility_code', 'TEXT'],
  ['provider_number', 'TEXT'],
  ['facility_type', 'TEXT'],
  ['pharmacy_facility_level', 'TEXT'],
  ['provider_level_code', 'TEXT'],
  ['credential_code', 'TEXT'],
  ['license_number', 'TEXT'],
  ['accreditation_expiry_date', 'TEXT'],
  ['integration_mode', "TEXT NOT NULL DEFAULT 'claimit_export'"],
  ['connection_profile', "TEXT NOT NULL DEFAULT 'local_server'"],
  ['validation_mode', "TEXT NOT NULL DEFAULT 'validate_before_submit'"],
  ['claim_control_mode', "TEXT NOT NULL DEFAULT 'manual'"],
  ['sandbox_base_url', 'TEXT'],
  ['production_base_url', 'TEXT'],
  ['scheme_name', "TEXT NOT NULL DEFAULT 'National Health Insurance'"],
  ['provider_type_description', 'TEXT'],
  ['provider_class_level', 'TEXT'],
  ['pharmacy_level', 'TEXT'],
  ['claims_officer_name', 'TEXT'],
  ['admission_payment_option', "TEXT NOT NULL DEFAULT 'nhis_pays_admission'"],
  ['claimit_validation_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['claims_officer_signature_url', 'TEXT'],
  ['submitter_id', 'TEXT'],
  ['api_base_url', 'TEXT'],
  ['api_key_encrypted', 'TEXT'],
  ['api_secret_encrypted', 'TEXT'],
  ['has_api_key', 'INTEGER NOT NULL DEFAULT 0'],
  ['has_api_secret', 'INTEGER NOT NULL DEFAULT 0'],
  ['api_key_header_name', 'TEXT'],
  ['api_secret_header_name', 'TEXT'],
  ['api_key_header_prefix', 'TEXT'],
  ['username', 'TEXT'],
  ['password_encrypted', 'TEXT'],
  ['token_endpoint_path', 'TEXT'],
  ['claim_endpoint_path', 'TEXT'],
  ['claim_submit_endpoint', 'TEXT'],
  ['claim_validation_endpoint_path', 'TEXT'],
  ['cc_endpoint_path', 'TEXT'],
  ['cc_code_endpoint_path', 'TEXT'],
  ['claim_status_endpoint_path', 'TEXT'],
  ['claim_status_endpoint', 'TEXT'],
  ['member_lookup_endpoint_path', 'TEXT'],
  ['member_lookup_endpoint', 'TEXT'],
  ['direct_api_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['credential_mode', "TEXT NOT NULL DEFAULT 'claimit_token'"],
  ['nhis_member_digits', 'INTEGER NOT NULL DEFAULT 8'],
  ['ghana_card_digits', 'INTEGER NOT NULL DEFAULT 10'],
  ['export_format', "TEXT NOT NULL DEFAULT 'json'"],
  ['max_retry_attempts', 'INTEGER NOT NULL DEFAULT 3'],
  ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
  ['created_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ['updated_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ['updated_by', 'TEXT'],
].forEach(([column, definition]) => ensureNhiaConfigurationColumn(column, definition))
db.exec(`
  INSERT OR IGNORE INTO nhia_configuration (
    id, organization_id, branch_id, facility_code, provider_number,
    provider_id, facility_type, pharmacy_facility_level, provider_level_code, credential_code,
    license_number, accreditation_expiry_date, integration_mode, connection_profile,
    validation_mode, claim_control_mode, sandbox_base_url, production_base_url,
    scheme_name, provider_type_description, provider_class_level, pharmacy_level,
    claims_officer_name, admission_payment_option, claimit_validation_enabled,
    claims_officer_signature_url, submitter_id, api_base_url, claim_endpoint_path,
    claim_submit_endpoint, claim_validation_endpoint_path, cc_endpoint_path, cc_code_endpoint_path,
    claim_status_endpoint_path, claim_status_endpoint, member_lookup_endpoint_path,
    member_lookup_endpoint, direct_api_enabled, credential_mode,
    nhis_member_digits, ghana_card_digits, export_format, max_retry_attempts,
    is_active, created_at, updated_at
  )
  SELECT
    id, organization_id, branch_id, facility_code, provider_number,
    provider_number, facility_type, pharmacy_facility_level, provider_level_code, credential_code,
    license_number, accreditation_expiry_date, integration_mode, connection_profile,
    validation_mode, claim_control_mode, sandbox_base_url, production_base_url,
    scheme_name, provider_type_description, provider_class_level, pharmacy_level,
    claims_officer_name, admission_payment_option, claimit_validation_enabled,
    claims_officer_signature_url, submitter_id, api_base_url, claim_endpoint_path,
    claim_endpoint_path, claim_validation_endpoint_path, cc_endpoint_path, cc_code_endpoint_path,
    claim_status_endpoint_path, claim_status_endpoint_path, member_lookup_endpoint_path,
    member_lookup_endpoint_path, direct_api_enabled, credential_mode,
    nhis_member_digits, ghana_card_digits, export_format, max_retry_attempts,
    is_active, created_at, updated_at
  FROM nhia_settings
`)
db.exec(`
  UPDATE nhia_configuration
  SET
    scheme_name = COALESCE(NULLIF(scheme_name, ''), 'National Health Insurance'),
    api_base_url = COALESCE(NULLIF(api_base_url, ''), 'https://elig.nhia.gov.gh:5000'),
    production_base_url = COALESCE(NULLIF(production_base_url, ''), 'http://localhost:31719/json-api'),
    member_lookup_endpoint_path = COALESCE(NULLIF(member_lookup_endpoint_path, ''), NULLIF(member_lookup_endpoint, ''), '/api/hmis/genCCC'),
    member_lookup_endpoint = COALESCE(NULLIF(member_lookup_endpoint, ''), NULLIF(member_lookup_endpoint_path, ''), '/api/hmis/genCCC'),
    claim_endpoint_path = COALESCE(NULLIF(claim_endpoint_path, ''), NULLIF(claim_submit_endpoint, ''), '/claims'),
    claim_submit_endpoint = COALESCE(NULLIF(claim_submit_endpoint, ''), NULLIF(claim_endpoint_path, ''), '/claims'),
    integration_mode = COALESCE(NULLIF(integration_mode, ''), 'claimit_assisted'),
    connection_profile = COALESCE(NULLIF(connection_profile, ''), 'local_server'),
    validation_mode = COALESCE(NULLIF(validation_mode, ''), 'validate_before_submit'),
    claim_control_mode = COALESCE(NULLIF(claim_control_mode, ''), 'manual'),
    credential_mode = COALESCE(NULLIF(credential_mode, ''), 'claimit_token'),
    api_key_header_name = COALESCE(NULLIF(api_key_header_name, ''), 'x-nhia-apikey'),
    api_secret_header_name = COALESCE(NULLIF(api_secret_header_name, ''), 'x-nhia-apisecret'),
    facility_type = COALESCE(NULLIF(facility_type, ''), 'Pharmacy'),
    pharmacy_facility_level = CASE
      WHEN facility_type = 'Hospital' THEN NULL
      ELSE COALESCE(NULLIF(pharmacy_facility_level, ''), NULLIF(pharmacy_level, ''), 'P1')
    END,
    admission_payment_option = COALESCE(NULLIF(admission_payment_option, ''), 'nhis_pays_admission'),
    claimit_validation_enabled = COALESCE(claimit_validation_enabled, 1),
    direct_api_enabled = COALESCE(direct_api_enabled, 0),
    export_format = COALESCE(NULLIF(export_format, ''), 'json'),
    nhis_member_digits = COALESCE(nhis_member_digits, 8),
    ghana_card_digits = COALESCE(ghana_card_digits, 10),
    max_retry_attempts = COALESCE(max_retry_attempts, 3),
    is_active = COALESCE(is_active, 1),
    updated_at = CURRENT_TIMESTAMP
`)
ensureColumn('nhia_claims', 'cc_code', 'TEXT')
ensureColumn('nhia_claims', 'diagnosis', 'TEXT')
ensureColumn('nhia_claims', 'diagnosis_details_json', "TEXT NOT NULL DEFAULT '[]'")
ensureColumn('nhia_claims', 'unserved_medicines_note', 'TEXT')
ensureColumn('nhia_claim_batches', 'cc_code', 'TEXT')
ensureColumn('nhia_claim_batches', 'cc_status', 'TEXT')

export const nowIso = () => new Date().toISOString()

export const createId = () => crypto.randomUUID()

export const parseJson = (value, fallback = null) => {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export const json = (value) => JSON.stringify(value ?? null)
