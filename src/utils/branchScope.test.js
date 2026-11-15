import { describe, expect, it } from 'vitest'
import { getBranchScopeId } from './branchScope'

const profile = { branch_id: 'branch-b' }

describe('which branch a member of staff is limited to (BRANCH-001)', () => {
  it.each(['branch_manager', 'cashier', 'pharmacist', 'assistant', 'inventory_officer', 'claims_officer'])(
    'limits a %s with a branch to that branch when Multi-branch is on',
    (role) => {
      expect(getBranchScopeId({ profile, role, multiBranchEnabled: true })).toBe('branch-b')
    }
  )

  it.each(['admin', 'super_admin', 'Admin', ' ADMIN '])('keeps %s organisation-wide', (role) => {
    expect(getBranchScopeId({ profile, role, multiBranchEnabled: true })).toBe('')
  })

  it('does nothing at a pharmacy without Multi-branch', () => {
    expect(getBranchScopeId({ profile, role: 'cashier', multiBranchEnabled: false })).toBe('')
    expect(getBranchScopeId({ profile, role: 'cashier' })).toBe('')
  })

  it('treats a member of staff with no branch as organisation-wide, as the transfers do', () => {
    expect(getBranchScopeId({ profile: { branch_id: null }, role: 'branch_manager', multiBranchEnabled: true })).toBe('')
    expect(getBranchScopeId({ profile: { branch_id: '  ' }, role: 'branch_manager', multiBranchEnabled: true })).toBe('')
    expect(getBranchScopeId({ profile: null, role: 'branch_manager', multiBranchEnabled: true })).toBe('')
    expect(getBranchScopeId()).toBe('')
  })
})
