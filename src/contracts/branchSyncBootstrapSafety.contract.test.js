import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const foundation = readFileSync(resolve(
  process.cwd(), 'supabase/migrations/20260528081000_create_branch_sync_foundation.sql'
), 'utf8')
const stockBootstrap = readFileSync(resolve(
  process.cwd(), 'supabase/migrations/20260821080000_promote_sale_stock_trigger.sql'
), 'utf8')
const saleBootstrap = readFileSync(resolve(
  process.cwd(), 'supabase/migrations/20260821081000_promote_branch_sync_sale_contract.sql'
), 'utf8')

describe('branch-sync bootstrap safety', () => {
  it('keeps credentials and idempotency records behind RLS', () => {
    expect(foundation).toContain('alter table public.branch_sync_clients enable row level security')
    expect(foundation).toContain('alter table public.branch_sync_events enable row level security')
    expect(foundation).toContain('unique (sync_client_id, event_type, local_id)')
  })

  it('never replaces a deployed stock or sale implementation', () => {
    expect(stockBootstrap).toContain("if to_regprocedure('public.update_drug_quantity_after_sale()') is null then")
    expect(stockBootstrap).toContain("if not exists (")
    expect(saleBootstrap).toContain("if to_regprocedure('public.branch_sync_create_sale_transaction(text,uuid,jsonb)') is null then")
    expect(saleBootstrap).toContain('v_existing.response')
    expect(saleBootstrap).toContain("event_type = 'sale.completed'")
  })

  it('retains the anchors required by the split-settlement migration', () => {
    expect(saleBootstrap).toContain('insurance_top_up_method_value TEXT;')
    expect(saleBootstrap).toContain('insurance_covered_value := COALESCE')
    expect(saleBootstrap).toContain('unit_cost_at_sale, line_cost')
  })
})
