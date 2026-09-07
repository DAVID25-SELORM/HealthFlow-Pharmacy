import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260907100000_add_nhis_inventory_serving_foundation.sql'),
  'utf8'
)
const effectMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260907102000_add_nhis_inventory_effect_rpc.sql'),
  'utf8'
)
const hardeningMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260907104000_baseline_nhis_inventory_policy_activation.sql'),
  'utf8'
)
const correctionMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260907105000_guard_nhis_inventory_medicine_corrections.sql'),
  'utf8'
)

describe('NHIS inventory-serving foundation', () => {
  it('preserves the existing stock-neutral default and restricts policy changes to administrators', () => {
    expect(migration).toContain('nhis_deduct_inventory_on_serve boolean not null default false')
    expect(migration).toContain("actor.role in ('admin', 'super_admin')")
    expect(migration).toContain("settings.nhis_inventory_policy_changed")
  })

  it('creates immutable, tenant-scoped serving and inventory idempotency records', () => {
    expect(migration).toContain('create table if not exists public.nhis_serving_events')
    expect(migration).toContain('unique (organization_id, idempotency_key)')
    expect(migration).toContain('create table if not exists public.nhis_inventory_ledger')
    expect(migration).toContain("movement_type in ('nhis_dispensing', 'nhis_dispensing_reversal')")
    expect(migration).toContain('reversal_of_ledger_id')
  })

  it('deducts only through the server-side serving path, including the dedicated branch completion RPC', () => {
    expect(effectMigration).toContain('apply_nhis_inventory_serving_effect')
    expect(effectMigration).toContain("'branch_offline_sync'")
    expect(effectMigration).toContain('branch_sync_complete_nhis_serving')
    expect(effectMigration).toContain("source_type, quantity, previous_quantity, new_quantity")
    expect(hardeningMigration).toContain('auth.uid() is not null')
  })

  it('baselines previously served quantities when the policy turns on', () => {
    expect(hardeningMigration).toContain('nhis_inventory_policy_activation_baselines')
    expect(hardeningMigration).toContain('sum(medicine.served_qty)')
    expect(hardeningMigration).toContain('v_required - v_baseline - v_applied')
    expect(hardeningMigration).toContain('cannot be reduced through ordinary editing')
  })

  it('blocks unsafe generic medicine corrections while retaining the cumulative serving route', () => {
    expect(correctionMigration).toContain('guard_nhis_inventory_medicine_correction')
    expect(correctionMigration).toContain("set_config('healthflow.nhis_serving_replacement', 'true', true)")
    expect(correctionMigration).toContain('controlled stock-correction workflow')
  })
})
