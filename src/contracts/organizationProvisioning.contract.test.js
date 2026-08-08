import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const source = fs.readFileSync('supabase/functions/tenant-signup/index.ts', 'utf8')

describe('ORG-READY-001 provisioning contract', () => {
  it('creates one active main branch and assigns the first administrator to it', () => {
    expect(source).toContain(".from('branches')")
    expect(source).toContain("code: 'MAIN'")
    expect(source).toContain('is_main: true')
    expect(source).toContain('branch_id: mainBranchId')
  })

  it('checks readiness before returning a provisioned tenant', () => {
    expect(source).toContain("contract: 'ORG-READY-001'")
    expect(source).toContain('const readiness = await checkOrganizationReadiness')
    expect(source).toContain('if (!readiness.ready)')
    expect(source).toContain("blockers.push('Organization owner is missing.')")
  })

  it('keeps readiness access behind the existing super-admin authorization', () => {
    expect(source).toContain("action === 'create_tenant' || action === 'check_organization_readiness'")
    expect(source).toContain('const authorizationResult = await requireSuperAdmin')
  })
})
