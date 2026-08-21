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
    expect(migration).toContain("v_definition like E'%\\\\n%'")
  })
})
