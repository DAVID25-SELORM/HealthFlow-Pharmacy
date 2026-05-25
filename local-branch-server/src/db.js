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
ensureColumn('nhia_settings', 'sandbox_base_url', 'TEXT')
ensureColumn('nhia_settings', 'production_base_url', 'TEXT')
ensureColumn('nhia_settings', 'claim_validation_endpoint_path', 'TEXT')
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
ensureColumn('nhia_claims', 'cc_code', 'TEXT')
ensureColumn('nhia_claims', 'diagnosis', 'TEXT')
ensureColumn('nhia_claims', 'diagnosis_details_json', "TEXT NOT NULL DEFAULT '[]'")
ensureColumn('nhia_claims', 'unserved_medicines_note', 'TEXT')

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
