import { db, nowIso } from './db.js'

const searchStatement = db.prepare(`
  SELECT *
  FROM drugs
  WHERE quantity > 0
    AND (
      @term = ''
      OR lower(name) LIKE @likeTerm
      OR lower(COALESCE(brand_name, '')) LIKE @likeTerm
      OR lower(COALESCE(generic_name, '')) LIKE @likeTerm
      OR lower(COALESCE(batch_number, '')) LIKE @likeTerm
      OR lower(COALESCE(nhis_code, '')) LIKE @likeTerm
      OR lower(COALESCE(barcode, '')) LIKE @likeTerm
    )
  ORDER BY name ASC
  LIMIT @limit
`)

const upsertDrug = db.prepare(`
  INSERT INTO drugs (
    id, name, brand_name, generic_name, batch_number, barcode, expiry_date, quantity, unit, price, cost_price,
    nhis_code, nhis_price, nhis_unit, is_nhis_listed, sale_on_return, branch_id, updated_at, sync_status
  )
  VALUES (
    @id, @name, @brand_name, @generic_name, @batch_number, @barcode, @expiry_date, @quantity, @unit, @price, @cost_price,
    @nhis_code, @nhis_price, @nhis_unit, @is_nhis_listed, @sale_on_return, @branch_id, @updated_at, 'synced'
  )
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    brand_name = excluded.brand_name,
    generic_name = excluded.generic_name,
    batch_number = excluded.batch_number,
    barcode = excluded.barcode,
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
    nhis_unit = excluded.nhis_unit,
    is_nhis_listed = excluded.is_nhis_listed,
    sale_on_return = excluded.sale_on_return,
    branch_id = excluded.branch_id,
    updated_at = excluded.updated_at,
    sync_status = CASE
      WHEN drugs.sync_status = 'pending' THEN drugs.sync_status
      ELSE 'synced'
    END
`)

const deleteDrugSearchTokens = db.prepare(`DELETE FROM inventory_search_tokens WHERE drug_id = ?`)
const deleteDrugBarcodes = db.prepare(`DELETE FROM barcodes WHERE drug_id = ?`)
const upsertDrugBarcode = db.prepare(`
  INSERT INTO barcodes (barcode, drug_id, updated_at)
  VALUES (@barcode, @drugId, @updatedAt)
  ON CONFLICT(barcode) DO UPDATE SET
    drug_id = excluded.drug_id,
    updated_at = excluded.updated_at
`)
const insertSearchToken = db.prepare(`
  INSERT OR IGNORE INTO inventory_search_tokens (drug_id, token, created_at)
  VALUES (@drugId, @token, @createdAt)
`)

const setMeta = db.prepare(`
  INSERT INTO branch_meta (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`)

const getMeta = db.prepare('SELECT value, updated_at FROM branch_meta WHERE key = ?')

const normalizeSearchTerm = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')

const extractSearchTokens = (value = '') =>
  [...new Set(normalizeSearchTerm(value).split(' ').filter(Boolean))]

const indexDrug = (drug = {}) => {
  deleteDrugSearchTokens.run(drug.id)
  deleteDrugBarcodes.run(drug.id)

  const timestamp = drug.updated_at || nowIso()
  const barcodeValue = String(drug.barcode || '').trim()
  if (barcodeValue) {
    upsertDrugBarcode.run({
      barcode: barcodeValue.toLowerCase(),
      drugId: drug.id,
      updatedAt: timestamp,
    })
  }

  const tokenSource = [
    drug.name,
    drug.brand_name,
    drug.generic_name,
    drug.batch_number,
    drug.nhis_code,
    barcodeValue,
  ]
    .filter(Boolean)
    .join(' ')

  for (const token of extractSearchTokens(tokenSource)) {
    insertSearchToken.run({
      drugId: drug.id,
      token,
      createdAt: timestamp,
    })
  }
}

export const searchLocalInventory = ({ term = '', limit = 30 } = {}) => {
  const normalizedTerm = normalizeSearchTerm(term)
  const maxResults = Math.min(Math.max(Number(limit) || 30, 1), 100)

  if (!normalizedTerm) {
    return searchStatement.all({
      term: normalizedTerm,
      likeTerm: '%',
      limit: maxResults,
    })
  }

  const barcodeTerm = normalizedTerm.replace(/\s+/g, '')
  if (barcodeTerm) {
    const barcodeResults = db.prepare(`
      SELECT d.*
      FROM drugs d
      JOIN barcodes b ON b.drug_id = d.id
      WHERE lower(b.barcode) = ?
        AND d.quantity > 0
      ORDER BY d.name ASC
      LIMIT ?
    `).all(barcodeTerm, maxResults)

    if (barcodeResults.length) {
      return barcodeResults
    }
  }

  const searchTokens = extractSearchTokens(normalizedTerm)
  const likeTerm = `%${normalizedTerm}%`

  if (searchTokens.length > 0) {
    const placeholders = searchTokens.map(() => '?').join(',')
    const tokenPrefixes = searchTokens.map((token) => `${token}%`)
    const prefixConditions = tokenPrefixes.map(() => 's.token LIKE ?').join(' OR ')
    return db
      .prepare(`
        SELECT DISTINCT d.*
        FROM drugs d
        LEFT JOIN inventory_search_tokens s ON s.drug_id = d.id
        WHERE d.quantity > 0
          AND (
            lower(d.name) LIKE ?
            OR lower(COALESCE(d.brand_name, '')) LIKE ?
            OR lower(COALESCE(d.generic_name, '')) LIKE ?
            OR lower(COALESCE(d.batch_number, '')) LIKE ?
            OR lower(COALESCE(d.nhis_code, '')) LIKE ?
            OR lower(COALESCE(d.barcode, '')) LIKE ?
            OR s.token IN (${placeholders})
            OR ${prefixConditions}
          )
        ORDER BY d.name ASC
        LIMIT ?
      `)
      .all(
        likeTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        ...searchTokens,
        ...tokenPrefixes,
        maxResults
      )
  }

  return searchStatement.all({
    term: normalizedTerm,
    likeTerm,
    limit: maxResults,
  })
}

const upsertDrugWithIndex = db.transaction((drug) => {
  upsertDrug.run({
    id: drug.id,
    name: drug.name,
    brand_name: drug.brand_name || null,
    generic_name: drug.generic_name || null,
    batch_number: drug.batch_number || null,
    barcode: drug.barcode || null,
    expiry_date: drug.expiry_date || null,
    quantity: Number(drug.quantity || 0),
    unit: drug.unit || null,
    price: Number(drug.price || 0),
    cost_price: drug.cost_price == null ? null : Number(drug.cost_price),
    nhis_code: drug.nhis_code || null,
    nhis_price: drug.nhis_price == null ? null : Number(drug.nhis_price),
    nhis_unit: drug.nhis_unit || null,
    is_nhis_listed: drug.is_nhis_listed ? 1 : 0,
    sale_on_return: drug.sale_on_return ? 1 : 0,
    branch_id: drug.branch_id || null,
    updated_at: drug.updated_at || nowIso(),
  })
  indexDrug(drug)
})

export const importInventorySnapshot = (drugs = []) => {
  const timestamp = nowIso()
  const insertMany = db.transaction((rows) => {
    for (const drug of rows) {
      upsertDrugWithIndex(drug)
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
