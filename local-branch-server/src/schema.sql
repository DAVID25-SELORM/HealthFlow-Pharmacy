PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS branch_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  role TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  insurance_provider TEXT,
  insurance_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS drugs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  batch_number TEXT,
  expiry_date TEXT,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT,
  price REAL NOT NULL DEFAULT 0,
  cost_price REAL,
  nhis_code TEXT,
  nhis_price REAL,
  is_nhis_listed INTEGER NOT NULL DEFAULT 0,
  branch_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE INDEX IF NOT EXISTS idx_drugs_search ON drugs(name, batch_number, nhis_code);
CREATE INDEX IF NOT EXISTS idx_drugs_branch ON drugs(branch_id);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  sale_number TEXT UNIQUE NOT NULL,
  remote_sale_id TEXT,
  remote_sale_number TEXT,
  patient_id TEXT,
  total_amount REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'completed',
  amount_paid REAL,
  change_given REAL,
  notes TEXT,
  sold_by TEXT,
  shift_id TEXT,
  organization_id TEXT,
  branch_id TEXT,
  sale_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  last_sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_sync_status ON sales(sync_status);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);

CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  drug_id TEXT NOT NULL,
  drug_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  claim_number TEXT UNIQUE NOT NULL,
  remote_claim_id TEXT,
  remote_claim_number TEXT,
  linked_local_sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  linked_local_sale_number TEXT,
  patient_id TEXT,
  patient_name TEXT NOT NULL,
  insurance_provider TEXT NOT NULL,
  insurance_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  total_amount REAL NOT NULL,
  claim_status TEXT NOT NULL DEFAULT 'pending',
  prescription_url TEXT,
  notes TEXT,
  submitted_by TEXT,
  organization_id TEXT,
  branch_id TEXT,
  submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  last_sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_sync_status ON claims(sync_status);
CREATE INDEX IF NOT EXISTS idx_claims_sale ON claims(linked_local_sale_id);

CREATE TABLE IF NOT EXISTS claim_items (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  drug_id TEXT NOT NULL,
  drug_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_claim_items_claim ON claim_items(claim_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  drug_id TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  previous_quantity REAL,
  new_quantity REAL,
  reference_id TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox(status, created_at);
