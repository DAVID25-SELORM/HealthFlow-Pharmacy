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
  surname TEXT,
  other_names TEXT,
  phone TEXT,
  email TEXT,
  insurance_provider TEXT,
  insurance_id TEXT,
  nhis_member_no TEXT,
  nhis_hin TEXT,
  member_no TEXT,
  hin TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name);
CREATE INDEX IF NOT EXISTS idx_patients_updated ON patients(updated_at);
CREATE INDEX IF NOT EXISTS idx_patients_insurance_id ON patients(insurance_id);

CREATE TABLE IF NOT EXISTS patient_search_tokens (
  patient_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (patient_id, token)
);

CREATE INDEX IF NOT EXISTS idx_patient_search_tokens_token ON patient_search_tokens(token);
CREATE INDEX IF NOT EXISTS idx_patient_search_tokens_patient ON patient_search_tokens(patient_id);

CREATE TABLE IF NOT EXISTS drugs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand_name TEXT,
  generic_name TEXT,
  batch_number TEXT,
  barcode TEXT,
  expiry_date TEXT,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT,
  price REAL NOT NULL DEFAULT 0,
  cost_price REAL,
  nhis_code TEXT,
  nhis_price REAL,
  nhis_unit TEXT,
  is_nhis_listed INTEGER NOT NULL DEFAULT 0,
  sale_on_return INTEGER NOT NULL DEFAULT 0,
  -- ✅ NHIS PHARMACY LEVEL PATCH START
  medicine_access_level TEXT,
  required_pharmacy_level TEXT,
  -- ✅ NHIS PHARMACY LEVEL PATCH END
  branch_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE INDEX IF NOT EXISTS idx_drugs_search ON drugs(name, batch_number, nhis_code);
CREATE INDEX IF NOT EXISTS idx_drugs_branch ON drugs(branch_id);

CREATE TABLE IF NOT EXISTS barcodes (
  barcode TEXT PRIMARY KEY,
  drug_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_barcodes_drug_id ON barcodes(drug_id);

CREATE TABLE IF NOT EXISTS inventory_search_tokens (
  drug_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (drug_id, token)
);

CREATE INDEX IF NOT EXISTS idx_inventory_search_tokens_token ON inventory_search_tokens(token);
CREATE INDEX IF NOT EXISTS idx_inventory_search_tokens_drug_id ON inventory_search_tokens(drug_id);

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

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'pending',
  provider_payment_id TEXT,
  authorization_url TEXT,
  access_code TEXT,
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT,
  webhook_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TEXT,
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_reference ON payment_attempts(reference);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_sale ON payment_attempts(sale_id, created_at);

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

-- ✅ OFFLINE-FIRST PATCH START
CREATE TABLE IF NOT EXISTS claim_status_queue (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  pending_sync INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_claim_status_queue_pending
  ON claim_status_queue(pending_sync, created_at);
CREATE INDEX IF NOT EXISTS idx_claim_status_queue_claim
  ON claim_status_queue(claim_id, created_at);
-- ✅ OFFLINE-FIRST PATCH END

CREATE TABLE IF NOT EXISTS nhia_settings (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  branch_id TEXT,
  facility_code TEXT,
  provider_number TEXT,
  hpn TEXT,
  hp_code TEXT,
  -- ✅ NHIA CONFIG PATCH START
  facility_type TEXT,
  pharmacy_facility_level TEXT,
  provider_level_code TEXT,
  credential_code TEXT,
  license_number TEXT,
  accreditation_expiry_date TEXT,
  -- ✅ NHIA API ARCHITECTURE PATCH START
  integration_mode TEXT NOT NULL DEFAULT 'claimit_export',
  connection_profile TEXT NOT NULL DEFAULT 'local_server',
  validation_mode TEXT NOT NULL DEFAULT 'validate_before_submit',
  claim_control_mode TEXT NOT NULL DEFAULT 'manual',
  sandbox_base_url TEXT,
  production_base_url TEXT,
  -- ✅ NHIA API ARCHITECTURE PATCH END
  -- ✅ NHIA CONFIG PATCH END
  scheme_name TEXT NOT NULL DEFAULT 'National Health Insurance',
  provider_type_description TEXT,
  provider_class_level TEXT,
  -- ✅ NHIS PHARMACY LEVEL PATCH START
  pharmacy_level TEXT,
  -- ✅ NHIS PHARMACY LEVEL PATCH END
  claims_officer_name TEXT,
  admission_payment_option TEXT NOT NULL DEFAULT 'nhis_pays_admission',
  claimit_validation_enabled INTEGER NOT NULL DEFAULT 1,
  claims_officer_signature_url TEXT,
  submitter_id TEXT,
  api_base_url TEXT,
  claim_endpoint_path TEXT,
  claim_validation_endpoint_path TEXT,
  cc_endpoint_path TEXT,
  cc_code_endpoint_path TEXT,
  claim_status_endpoint_path TEXT,
  member_lookup_endpoint_path TEXT,
  direct_api_enabled INTEGER NOT NULL DEFAULT 0,
  credential_mode TEXT NOT NULL DEFAULT 'api_key',
  credential_payload TEXT NOT NULL DEFAULT '{}',
  nhis_member_digits INTEGER NOT NULL DEFAULT 8,
  ghana_card_digits INTEGER NOT NULL DEFAULT 10,
  export_format TEXT NOT NULL DEFAULT 'json',
  max_retry_attempts INTEGER NOT NULL DEFAULT 3,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nhia_settings_org_branch
  ON nhia_settings(COALESCE(organization_id, ''), COALESCE(branch_id, ''));

CREATE TABLE IF NOT EXISTS nhia_configuration (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  branch_id TEXT,
  mode TEXT NOT NULL DEFAULT 'OFFLINE_LOCAL',
  provider_id TEXT,
  facility_code TEXT,
  provider_number TEXT,
  hpn TEXT,
  hp_code TEXT,
  facility_type TEXT,
  pharmacy_facility_level TEXT,
  provider_level_code TEXT,
  credential_code TEXT,
  license_number TEXT,
  accreditation_expiry_date TEXT,
  integration_mode TEXT NOT NULL DEFAULT 'claimit_export',
  connection_profile TEXT NOT NULL DEFAULT 'local_server',
  validation_mode TEXT NOT NULL DEFAULT 'validate_before_submit',
  claim_control_mode TEXT NOT NULL DEFAULT 'manual',
  sandbox_base_url TEXT,
  production_base_url TEXT,
  scheme_name TEXT NOT NULL DEFAULT 'National Health Insurance',
  provider_type_description TEXT,
  provider_class_level TEXT,
  pharmacy_level TEXT,
  claims_officer_name TEXT,
  admission_payment_option TEXT NOT NULL DEFAULT 'nhis_pays_admission',
  claimit_validation_enabled INTEGER NOT NULL DEFAULT 1,
  claims_officer_signature_url TEXT,
  submitter_id TEXT,
  api_base_url TEXT,
  api_key_encrypted TEXT,
  api_secret_encrypted TEXT,
  has_api_key INTEGER NOT NULL DEFAULT 0,
  has_api_secret INTEGER NOT NULL DEFAULT 0,
  api_key_header_name TEXT,
  api_secret_header_name TEXT,
  api_key_header_prefix TEXT,
  username TEXT,
  password_encrypted TEXT,
  token_endpoint_path TEXT,
  claim_endpoint_path TEXT,
  claim_submit_endpoint TEXT,
  claim_validation_endpoint_path TEXT,
  cc_endpoint_path TEXT,
  cc_code_endpoint_path TEXT,
  claim_status_endpoint_path TEXT,
  claim_status_endpoint TEXT,
  member_lookup_endpoint_path TEXT,
  member_lookup_endpoint TEXT,
  direct_api_enabled INTEGER NOT NULL DEFAULT 0,
  credential_mode TEXT NOT NULL DEFAULT 'api_key',
  nhis_member_digits INTEGER NOT NULL DEFAULT 8,
  ghana_card_digits INTEGER NOT NULL DEFAULT 10,
  export_format TEXT NOT NULL DEFAULT 'json',
  max_retry_attempts INTEGER NOT NULL DEFAULT 3,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nhia_configuration_org_branch
  ON nhia_configuration(COALESCE(organization_id, ''), COALESCE(branch_id, ''));

CREATE TABLE IF NOT EXISTS nhia_claims (
  id TEXT PRIMARY KEY,
  claim_number TEXT UNIQUE NOT NULL,
  local_sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
  local_sale_number TEXT,
  batch_id TEXT,
  patient_id TEXT,
  patient_name TEXT NOT NULL,
  member_number TEXT NOT NULL,
  card_type TEXT,
  hin TEXT,
  cc_code TEXT,
  nhia_auth_id TEXT,
  nhia_auth_type TEXT,
  nhia_new_ccc_status TEXT,
  nhia_otac TEXT,
  nhia_attendance_date TEXT,
  nhia_attendance_verification_status TEXT,
  nhia_attendance_verification_source TEXT,
  diagnosis TEXT,
  diagnosis_details_json TEXT NOT NULL DEFAULT '[]',
  unserved_medicines_note TEXT,
  insurance_provider TEXT,
  service_date TEXT NOT NULL,
  total_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  payload_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  submitted_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  paid_at TEXT,
  organization_id TEXT,
  branch_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nhia_claims_status ON nhia_claims(status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_nhia_claims_sale ON nhia_claims(local_sale_id);

CREATE TABLE IF NOT EXISTS nhia_claim_items (
  id TEXT PRIMARY KEY,
  nhia_claim_id TEXT NOT NULL REFERENCES nhia_claims(id) ON DELETE CASCADE,
  drug_id TEXT,
  drug_name TEXT NOT NULL,
  nhia_code TEXT,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nhia_claim_items_claim ON nhia_claim_items(nhia_claim_id);

CREATE TABLE IF NOT EXISTS nhia_claim_services (
  id TEXT PRIMARY KEY,
  nhia_claim_id TEXT NOT NULL REFERENCES nhia_claims(id) ON DELETE CASCADE,
  gdrg_code TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_amount REAL NOT NULL,
  age_band TEXT,
  facility_group TEXT,
  catering_option TEXT,
  mdc TEXT,
  service_date TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nhia_claim_services_claim ON nhia_claim_services(nhia_claim_id);

CREATE TABLE IF NOT EXISTS nhia_claim_batches (
  id TEXT PRIMARY KEY,
  batch_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  export_format TEXT NOT NULL DEFAULT 'json',
  claim_count INTEGER NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT,
  cc_code TEXT,
  cc_status TEXT,
  file_name TEXT,
  organization_id TEXT,
  branch_id TEXT,
  created_by TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nhia_claim_batches_status ON nhia_claim_batches(status, created_at);

CREATE TABLE IF NOT EXISTS nhia_submission_logs (
  id TEXT PRIMARY KEY,
  nhia_claim_id TEXT REFERENCES nhia_claims(id) ON DELETE SET NULL,
  batch_id TEXT REFERENCES nhia_claim_batches(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  request_json TEXT,
  response_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nhia_submission_logs_claim ON nhia_submission_logs(nhia_claim_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nhia_submission_logs_batch ON nhia_submission_logs(batch_id, created_at);

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

-- ✅ OFFLINE-FIRST PATCH START
CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload_json TEXT NOT NULL,
  pending_sync INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_events_pending
  ON sync_events(pending_sync, status, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_events_entity
  ON sync_events(entity_type, entity_id);
-- ✅ OFFLINE-FIRST PATCH END

CREATE TABLE IF NOT EXISTS offline_records (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_offline_records_entity ON offline_records(entity_type, updated_at);
CREATE INDEX IF NOT EXISTS idx_offline_records_sync ON offline_records(sync_status, updated_at);
