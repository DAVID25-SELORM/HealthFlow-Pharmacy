import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: { profile: { branch_id: 'branch-b', organization_id: 'org-1' }, role: 'cashier' },
  tenant: { canUseMultiBranch: true },
  getActiveBranchCount: vi.fn(),
}))

vi.mock('../context/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../context/TenantContext', () => ({ useTenant: () => mocks.tenant }))
vi.mock('../services/branchService', () => ({ getActiveBranchCount: mocks.getActiveBranchCount }))

import { resetBranchCountCacheForTests, useBranchScope } from './useBranchScope'

describe('useBranchScope (BRANCH-001)', () => {
  beforeEach(() => {
    resetBranchCountCacheForTests()
    mocks.getActiveBranchCount.mockReset()
    mocks.auth.profile = { branch_id: 'branch-b', organization_id: 'org-1' }
    mocks.auth.role = 'cashier'
    mocks.tenant.canUseMultiBranch = true
  })

  it('limits branch staff while the branch count is loading, then keeps the limit for two or more branches', async () => {
    mocks.getActiveBranchCount.mockResolvedValue(2)
    const { result } = renderHook(() => useBranchScope())

    expect(result.current).toBe('branch-b')
    await waitFor(() => expect(mocks.getActiveBranchCount).toHaveBeenCalledTimes(1))
    expect(result.current).toBe('branch-b')
  })

  it('releases staff of a single-branch pharmacy once the count is known', async () => {
    mocks.getActiveBranchCount.mockResolvedValue(1)
    const { result } = renderHook(() => useBranchScope())

    await waitFor(() => expect(result.current).toBe(''))
  })

  it('keeps the limit on when the count cannot be read', async () => {
    mocks.getActiveBranchCount.mockRejectedValue(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderHook(() => useBranchScope())

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current).toBe('branch-b')
    warn.mockRestore()
  })

  it('reads the count once per pharmacy for the session', async () => {
    mocks.getActiveBranchCount.mockResolvedValue(1)
    const first = renderHook(() => useBranchScope())
    await waitFor(() => expect(first.result.current).toBe(''))
    const second = renderHook(() => useBranchScope())

    expect(second.result.current).toBe('')
    expect(mocks.getActiveBranchCount).toHaveBeenCalledTimes(1)
  })

  it('does not read the count for administrators, staff with no branch, or a pharmacy without Multi-branch', async () => {
    mocks.auth.role = 'admin'
    renderHook(() => useBranchScope())
    mocks.auth.role = 'cashier'
    mocks.auth.profile = { branch_id: null, organization_id: 'org-1' }
    renderHook(() => useBranchScope())
    mocks.auth.profile = { branch_id: 'branch-b', organization_id: 'org-1' }
    mocks.tenant.canUseMultiBranch = false
    const { result } = renderHook(() => useBranchScope())

    expect(result.current).toBe('')
    expect(mocks.getActiveBranchCount).not.toHaveBeenCalled()
  })
})
