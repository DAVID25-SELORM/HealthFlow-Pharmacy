// One offline computer holds one pharmacy's records. The local screens show whatever is in the database without
// asking whose it is, so a computer connected to a second pharmacy showed that pharmacy the first one's patients.
// These functions work out whose records a database holds. They take an open database and import nothing, so the
// setup script can use them on a database it only reads.

export const DATA_OWNER_KEY = 'data_owner_organization_id'

export const DATA_LOCKED_MESSAGE =
  "This offline computer holds another pharmacy's records, so it is locked to protect them. Do not delete anything. " +
  'Connect it back to the pharmacy it belongs to, or ask HealthFlow support to archive the records before it is used ' +
  'for another pharmacy.'

export const CONNECT_REFUSED_MESSAGE =
  "This computer already holds another pharmacy's records, so it cannot be connected to a different pharmacy. " +
  'Use a different computer, or first archive the records with prepare-for-another-pharmacy.ps1.'

// Tables with an organization_id column. `users` is left out on purpose: earlier versions saved the details of an
// outsider who tried to sign in, and that must not count as the outsider owning the data.
const OWNED_TABLES = [
  'sales', 'local_pos_sessions', 'claims', 'nhia_settings', 'nhia_configuration', 'nhia_claims', 'nhia_claim_batches',
]
const OWNED_JSON_COLUMNS = [['offline_records', 'data_json'], ['sync_outbox', 'payload_json']]
const RECORD_TABLES = [
  'patients', 'drugs', 'sales', 'claims', 'nhia_claims', 'offline_records', 'sync_outbox', 'local_pos_sessions',
]

const normalizeId = (value) => String(value || '').trim().toLowerCase()

const hasTable = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))

const hasColumn = (db, table, column) =>
  hasTable(db, table) && db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)

const readMeta = (db, key) =>
  hasTable(db, 'branch_meta')
    ? db.prepare('SELECT value FROM branch_meta WHERE key = ?').get(key)?.value || ''
    : ''

export const readDataOwnerStamp = (db) => normalizeId(readMeta(db, DATA_OWNER_KEY))

const findOwnersInRecords = (db) => {
  const owners = new Set()
  const add = (value) => {
    const id = normalizeId(value)
    if (id) owners.add(id)
  }
  for (const table of OWNED_TABLES) {
    if (!hasColumn(db, table, 'organization_id')) continue
    for (const row of db.prepare(`SELECT DISTINCT organization_id AS id FROM ${table}`).all()) add(row.id)
  }
  for (const [table, column] of OWNED_JSON_COLUMNS) {
    if (!hasColumn(db, table, column)) continue
    const rows = db.prepare(`
      SELECT DISTINCT COALESCE(
        NULLIF(json_extract(${column}, '$.organization_id'), ''),
        NULLIF(json_extract(${column}, '$.organizationId'), '')
      ) AS id
      FROM ${table}
      WHERE json_valid(${column})
    `).all()
    for (const row of rows) add(row.id)
  }
  try {
    for (const organization of JSON.parse(readMeta(db, 'organization_snapshot') || '[]')) add(organization?.id)
  } catch {
    // A snapshot that cannot be read tells nothing about the owner.
  }
  return owners
}

export const hasFacilityRecords = (db) =>
  RECORD_TABLES.some((table) => hasTable(db, table) && Boolean(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))

// The pharmacies whose records this database holds. Once the database has been marked, the mark alone decides.
// `previousOrganizationId` is the pharmacy the computer was connected to until now: its records are its own even
// where a record does not say so.
export const getDataOwners = (db, { previousOrganizationId = '' } = {}) => {
  const stamp = readDataOwnerStamp(db)
  if (stamp) return [stamp]
  const owners = findOwnersInRecords(db)
  const previous = normalizeId(previousOrganizationId)
  if (previous && hasFacilityRecords(db)) owners.add(previous)
  return [...owners]
}

// Run when the server starts. Marks the database for the connected pharmacy, or reports that it must stay locked.
export const evaluateDataOwner = (db, organizationId) => {
  const connected = normalizeId(organizationId)
  const owners = getDataOwners(db)
  if (owners.some((owner) => owner !== connected)) return { locked: true }
  if (connected && !readDataOwnerStamp(db)) {
    db.prepare(`
      INSERT INTO branch_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(DATA_OWNER_KEY, connected, new Date().toISOString())
  }
  return { locked: false }
}

export const assertDataAllowsConnection = (db, organizationId, previousOrganizationId = '') => {
  const next = normalizeId(organizationId)
  if (getDataOwners(db, { previousOrganizationId }).some((owner) => owner !== next)) {
    throw Object.assign(new Error(CONNECT_REFUSED_MESSAGE), { status: 400 })
  }
}
