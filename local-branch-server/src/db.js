import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

const schemaPath = new URL('./schema.sql', import.meta.url)

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true })

export const db = new Database(config.sqlitePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(fs.readFileSync(schemaPath, 'utf8'))

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
