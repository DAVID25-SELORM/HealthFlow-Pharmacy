import { db, nowIso } from './db.js'

const searchStatement = db.prepare(`
  SELECT *
  FROM drugs
  WHERE quantity > 0
    AND (
      @term = ''
      OR lower(name) LIKE @likeTerm
      OR lower(COALESCE(batch_number, '')) LIKE @likeTerm
      OR lower(COALESCE(nhis_code, '')) LIKE @likeTerm
    )
  ORDER BY name ASC
  LIMIT @limit
`)

const upsertDrug = db.prepare(`
  INSERT INTO drugs (
    id, name, batch_number, expiry_date, quantity, unit, price, cost_price,
    nhis_code, nhis_price, is_nhis_listed, branch_id, updated_at, sync_status
  )
  VALUES (
    @id, @name, @batch_number, @expiry_date, @quantity, @unit, @price, @cost_price,
    @nhis_code, @nhis_price, @is_nhis_listed, @branch_id, @updated_at, 'synced'
  )
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    batch_number = excluded.batch_number,
    expiry_date = excluded.expiry_date,
    quantity = CASE
      WHEN drugs.sync_status = 'pending' THEN drugs.quantity
      ELSE excluded.quantity
    END,
    unit = excluded.unit,
    price = excluded.price,
    cost_price = excluded.cost_price,
    nhis_code = excluded.nhis_code,
    nhis_price = excluded.nhis_price,
    is_nhis_listed = excluded.is_nhis_listed,
    branch_id = excluded.branch_id,
    updated_at = excluded.updated_at,
    sync_status = CASE
      WHEN drugs.sync_status = 'pending' THEN drugs.sync_status
      ELSE 'synced'
    END
`)

const setMeta = db.prepare(`
  INSERT INTO branch_meta (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`)

const getMeta = db.prepare('SELECT value, updated_at FROM branch_meta WHERE key = ?')

export const searchLocalInventory = ({ term = '', limit = 30 } = {}) => {
  const normalizedTerm = String(term || '').trim().toLowerCase()
  return searchStatement.all({
    term: normalizedTerm,
    likeTerm: `%${normalizedTerm}%`,
    limit: Math.min(Math.max(Number(limit) || 30, 1), 100),
  })
}

export const importInventorySnapshot = (drugs = []) => {
  const timestamp = nowIso()
  const insertMany = db.transaction((rows) => {
    for (const drug of rows) {
      upsertDrug.run({
        id: drug.id,
        name: drug.name,
        batch_number: drug.batch_number || null,
        expiry_date: drug.expiry_date || null,
        quantity: Number(drug.quantity || 0),
        unit: drug.unit || null,
        price: Number(drug.price || 0),
        cost_price: drug.cost_price == null ? null : Number(drug.cost_price),
        nhis_code: drug.nhis_code || null,
        nhis_price: drug.nhis_price == null ? null : Number(drug.nhis_price),
        is_nhis_listed: drug.is_nhis_listed ? 1 : 0,
        branch_id: drug.branch_id || null,
        updated_at: drug.updated_at || timestamp,
      })
    }
  })

  insertMany(Array.isArray(drugs) ? drugs : [])
  setMeta.run('last_inventory_import_at', timestamp, timestamp)
  setMeta.run('last_inventory_import_count', String(Array.isArray(drugs) ? drugs.length : 0), timestamp)
  return { imported: Array.isArray(drugs) ? drugs.length : 0, importedAt: timestamp }
}

export const getInventoryImportStatus = () => ({
  lastInventoryImportAt: getMeta.get('last_inventory_import_at')?.value || null,
  lastInventoryImportCount: Number(getMeta.get('last_inventory_import_count')?.value || 0),
})
