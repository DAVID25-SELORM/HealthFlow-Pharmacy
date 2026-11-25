import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = []
let responses = {}

// A chainable stand-in for the query builder: records every step and answers from `responses[table]`.
const builder = (table) => {
  const record = { table, steps: [] }
  calls.push(record)
  const proxy = new Proxy({}, {
    get(_target, name) {
      if (name === 'then') {
        const queue = responses[table] || []
        const answer = queue.length ? queue.shift() : { data: [], error: null }
        return (resolve, reject) => Promise.resolve(answer).then(resolve, reject)
      }
      return (...args) => { record.steps.push([name, ...args]); return proxy }
    },
  })
  return proxy
}

vi.mock('../lib/supabase', () => ({ supabase: { from: (table) => builder(table) } }))

import { searchCashSaleMedicines, searchMedicineLines, searchNhisClaimMedicines } from './nhisMedicineSearchService'

const OPTIONS = { organizationId: 'org1', fromDate: '2026-09-01', toDate: '2026-11-30', terms: ['tamoxifen', 'xeloda'] }
const stepsOf = (record, name) => record.steps.filter((step) => step[0] === name)

const saleItem = (id, overrides = {}) => ({
  id,
  drug_id: 'drug-1',
  quantity: 3,
  unit_price: 4,
  total_price: 12,
  drugs: { name: 'Tamoxifen Tablet 20mg' },
  sales: {
    id: `sale-${id}`,
    sale_number: `SL-${id}`,
    sale_date: '2026-10-08T09:30:00+00:00',
    patients: { id: 'pat-1', full_name: 'Kwesi Mensah', folder_no: 'P-1', nhis_member_no: '', insurance_id: 'INS-9', date_of_birth: '1980-02-02', gender: 'Male' },
  },
  ...overrides,
})

describe('medicine search queries', () => {
  beforeEach(() => {
    calls.length = 0
    responses = {}
    vi.stubGlobal('navigator', { onLine: true })
  })

  it('finds the drugs by name first, then only the sale lines for those drugs, for this pharmacy and period', async () => {
    responses = { drugs: [{ data: [{ id: 'drug-1', name: 'Tamoxifen' }, { id: 'drug-2', name: 'Xeloda' }], error: null }], sale_items: [{ data: [saleItem('1')], error: null }] }
    const lines = await searchCashSaleMedicines(OPTIONS)

    const [drugQuery, itemQuery] = calls
    expect(drugQuery.table).toBe('drugs')
    expect(stepsOf(drugQuery, 'or')[0][1]).toBe('name.ilike."*tamoxifen*",name.ilike."*xeloda*"')
    expect(stepsOf(drugQuery, 'eq')).toContainEqual(['eq', 'organization_id', 'org1'])

    expect(itemQuery.table).toBe('sale_items')
    expect(stepsOf(itemQuery, 'in')[0]).toEqual(['in', 'drug_id', ['drug-1', 'drug-2']])
    expect(stepsOf(itemQuery, 'eq')).toContainEqual(['eq', 'sales.payment_status', 'completed'])
    expect(stepsOf(itemQuery, 'eq')).toContainEqual(['eq', 'sales.organization_id', 'org1'])
    expect(stepsOf(itemQuery, 'gte')[0]).toEqual(['gte', 'sales.sale_date', '2026-09-01'])
    // the last day is included by stopping before the next one
    expect(stepsOf(itemQuery, 'lt')[0]).toEqual(['lt', 'sales.sale_date', '2026-12-01'])

    expect(lines).toHaveLength(1)
  })

  it('turns a sale line into the same shape as a claim line', async () => {
    responses = { drugs: [{ data: [{ id: 'drug-1' }], error: null }], sale_items: [{ data: [saleItem('1')], error: null }] }
    const [line] = await searchCashSaleMedicines(OPTIONS)
    expect(line).toMatchObject({
      source: 'cash', hasPatient: true, description: 'Tamoxifen Tablet 20mg', dispensed_qty: 3, unit_price: 4, total_amount: 12,
      dispensary_date: '2026-10-08',
    })
    expect(line.claim).toMatchObject({
      claim_number: 'SL-1', surname: 'Kwesi Mensah', member_no: 'INS-9', folder_no: 'P-1', patient_id: 'pat-1', service_date_from: '2026-10-08',
    })
  })

  it('marks a sale with no patient, and works the amount out when there is no total', async () => {
    const walkIn = saleItem('2', { total_price: null, sales: { id: 'sale-2', sale_number: 'SL-2', sale_date: '2026-10-09', patients: null } })
    responses = { drugs: [{ data: [{ id: 'drug-1' }], error: null }], sale_items: [{ data: [walkIn], error: null }] }
    const [line] = await searchCashSaleMedicines(OPTIONS)
    expect(line.hasPatient).toBe(false)
    expect(line.total_amount).toBe(12)
  })

  it('returns nothing, without asking for sales, when no drug has that name', async () => {
    responses = { drugs: [{ data: [], error: null }] }
    expect(await searchCashSaleMedicines(OPTIONS)).toEqual([])
    expect(calls.map((call) => call.table)).toEqual(['drugs'])
  })

  it('reads every page of a big result', async () => {
    const page = Array.from({ length: 1000 }, (_, index) => saleItem(`a${index}`))
    responses = { drugs: [{ data: [{ id: 'drug-1' }], error: null }], sale_items: [{ data: page, error: null }, { data: [saleItem('last')], error: null }] }
    expect(await searchCashSaleMedicines(OPTIONS)).toHaveLength(1001)
    const itemCalls = calls.filter((call) => call.table === 'sale_items')
    expect(stepsOf(itemCalls[1], 'range')[0]).toEqual(['range', 1000, 1999])
  })

  it('passes a database error on as a readable message', async () => {
    responses = { drugs: [{ data: null, error: { message: 'permission denied' } }] }
    await expect(searchCashSaleMedicines(OPTIONS)).rejects.toThrow('permission denied')
  })

  it('needs an internet connection', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    await expect(searchCashSaleMedicines(OPTIONS)).rejects.toThrow(/internet connection/)
    await expect(searchNhisClaimMedicines(OPTIONS)).rejects.toThrow(/internet connection/)
  })

  it('removes characters that could break the filter text', async () => {
    responses = { drugs: [{ data: [], error: null }] }
    await searchCashSaleMedicines({ ...OPTIONS, terms: ['tamo,xi(fen)*'] })
    expect(stepsOf(calls[0], 'or')[0][1]).toBe('name.ilike."*tamo xi fen*"')
  })

  it('searches claims only, cash sales only, or both', async () => {
    const claimRow = { id: 'L1', nhis_claims: { id: 'C1', status: 'served' }, description: 'Tamoxifen' }
    const run = async (source) => {
      calls.length = 0
      responses = {
        nhis_claim_medicines: [{ data: [claimRow], error: null }],
        drugs: [{ data: [{ id: 'drug-1' }], error: null }],
        sale_items: [{ data: [saleItem('1')], error: null }],
      }
      const lines = await searchMedicineLines({ ...OPTIONS, source })
      return { lines, tables: calls.map((call) => call.table) }
    }

    const nhis = await run('nhis')
    expect(nhis.tables).toEqual(['nhis_claim_medicines'])
    expect(nhis.lines.map((line) => line.source)).toEqual(['nhis'])

    const cash = await run('cash')
    expect(cash.tables).toEqual(['drugs', 'sale_items'])
    expect(cash.lines.map((line) => line.source)).toEqual(['cash'])

    const all = await run('all')
    expect(all.tables.sort()).toEqual(['drugs', 'nhis_claim_medicines', 'sale_items'])
    expect(all.lines.map((line) => line.source).sort()).toEqual(['cash', 'nhis'])
  })
})
