import { describe, expect, it } from 'vitest'
import { readFileSync } from '../test/readFileSyncLf.js'
import { resolve } from 'node:path'

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

const migration = read('supabase/migrations/20261122120000_add_organization_interface_flags.sql')
const layout = read('src/components/Layout/Layout.jsx')
const flags = read('src/utils/interfaceFlags.js')

describe('per-pharmacy interface switch', () => {
  it('adds only a defaulted column and one platform-admin-only function', () => {
    expect(migration).toMatch(/add column if not exists interface_flags jsonb not null default '\{\}'::jsonb/)
    expect(migration).not.toMatch(/\bdrop\s+(table|column)\b/i)
    expect(migration).not.toMatch(/\bdelete\s+from\b/i)
    expect(migration).not.toMatch(/\bupdate\s+public\.(?!organizations)/i)
    expect(migration).toMatch(/role = 'super_admin'/)
    expect(migration).toMatch(/security definer\s+set search_path = public, pg_catalog/)
    expect(migration).toMatch(/revoke all on function public\.set_organization_interface_flag\(uuid, text, boolean\) from public/)
  })

  it('only accepts known flags', () => {
    expect(migration).toMatch(/p_flag not in \('classic_navigation'\)/)
    expect(flags).toMatch(/classicNavigation: 'classic_navigation'/)
  })

  it('leaves the new navigation on unless the flag is exactly true', () => {
    expect(flags).toMatch(/interface_flags\?\.\[flag\] === true/)
    expect(layout).toMatch(/\{!classicNavigation && <BottomNav \/>\}/)
    expect(layout).toMatch(/const isSidebarCollapsed = !classicNavigation && collapsePreference && isDesktop/)
  })
})
