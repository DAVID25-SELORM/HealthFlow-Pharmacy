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
db.exec('CREATE INDEX IF NOT EXISTS idx_drugs_barcode ON drugs(barcode)')
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
