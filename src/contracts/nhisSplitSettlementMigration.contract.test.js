import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260821100000_add_nhis_split_settlement.sql'
), 'utf8')

describe('NHIS split-settlement migration contract', () => {
  it('uses escaped strings when patching generated sale-function SQL', () => {
    expect(migration).toContain(
      "E'insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method,\\n"
    )
    expect(migration).toContain(
      "E'insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value,\\n"
    )
    expect(migration).toContain(
      "E'total_price, unit_cost_at_sale, line_cost,\\n"
    )
    expect(migration).toContain("position(E'\\\\n' in v_definition) > 0")
  })

  it('is safe to rerun after one sale function was already patched', () => {
    expect(migration).toContain('Do not append the settlement fields a second time on retry.')
    expect(migration).toContain("v_definition like '%nhis_covered_value NUMERIC(12, 2);%'")
    expect(migration).toContain('has an incomplete split-settlement patch')
    expect(migration).toContain('continue;')
  })

  it('fails closed instead of silently skipping an unexpected refund function', () => {
    expect(migration).toContain('Already patched by a previous successful SQL-editor run.')
    expect(migration).toContain('Unexpected refund-sale definition; refusing split-settlement refund patch')
    expect(migration).toContain('v_sale.patient_payment_method, v_sale.insurance_top_up_payment_method')
  })
})
