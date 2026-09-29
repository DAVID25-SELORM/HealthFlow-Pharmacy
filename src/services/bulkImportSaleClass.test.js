// @vitest-environment node
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'
import { expect, it, vi } from 'vitest'

it('imports ordinary spreadsheet rows without nulling new or existing sale classifications', async () => {
  const source = readFileSync('supabase/functions/tier-access/index.ts', 'utf8')
  const body = source.slice(source.indexOf('const bulkImportDrugs ='), source.indexOf('const syncNhisDrugsToInventory ='))
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const db = new PGlite()
  try {
    await db.exec("create table drugs(name text primary key, epharmacy_sale_class text not null default 'otc'); insert into drugs values ('Existing medicine', 'prescription')")
    const save = vi.fn(async (_client, _org, _branch, drug) => {
      const existing = (await db.query('select * from drugs where name=$1', [drug.name])).rows[0]
      const hasClass = Object.hasOwn(drug, 'epharmacy_sale_class')
      if (existing && hasClass) await db.query('update drugs set epharmacy_sale_class=$2 where name=$1', [drug.name, drug.epharmacy_sale_class])
      if (!existing) {
        if (hasClass) await db.query('insert into drugs values ($1,$2)', [drug.name, drug.epharmacy_sale_class])
        else await db.query('insert into drugs(name) values ($1)', [drug.name])
      }
      return { action: existing ? 'update_existing' : 'create', drug }
    })
    const normalize = (value) => typeof value === 'string' ? value.trim() : ''
    const dependencies = {
      requireStockAdjustmentAccess: () => {}, getBranchIdForInventoryRequest: async () => 'branch',
      isChemicalShopOrganization: async () => false, normalizeText: normalize,
      assertCustomBatchNumberAllowed: () => {}, assertRequiredText: normalize,
      parseNonNegativeNumber: Number, normalizeMedicineAccessLevelForSave: normalize,
      isChemicalShopMedicineAllowed: () => true, saveDrugForOrganization: save,
      getErrorMessage: (error) => error.message,
    }
    const run = new Function(...Object.keys(dependencies), `${js}; return bulkImportDrugs`)(...Object.values(dependencies))
    const result = await run({}, {}, 'org', { drugs: [
      { name: 'New medicine', expiry_date: '2028-01-01', quantity: 1, price: 1 },
      { name: 'Existing medicine', expiry_date: '2028-01-01', quantity: 1, price: 1 },
      { name: 'Explicit medicine', expiry_date: '2028-01-01', quantity: 1, price: 1, epharmacy_sale_class: 'prescription' },
    ] })
    expect(result.failed).toEqual([])
    expect(result.successful).toHaveLength(3)
    expect((await db.query('select * from drugs order by name')).rows).toEqual([
      { name: 'Existing medicine', epharmacy_sale_class: 'prescription' },
      { name: 'Explicit medicine', epharmacy_sale_class: 'prescription' },
      { name: 'New medicine', epharmacy_sale_class: 'otc' },
    ])
  } finally { await db.close() }
}, 30000)
