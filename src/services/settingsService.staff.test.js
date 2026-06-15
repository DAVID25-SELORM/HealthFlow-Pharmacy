import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeSupabaseFunction } = vi.hoisted(() => ({
  invokeSupabaseFunction: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  getCurrentSupabaseUser: vi.fn(),
  invokeSupabaseFunction,
  supabase: {
    from: vi.fn(),
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: vi.fn(),
}))

import { createStaffUser, updateStaffUser } from './settingsService'

describe('settingsService staff administration', () => {
  beforeEach(() => {
    invokeSupabaseFunction.mockReset()
    invokeSupabaseFunction.mockResolvedValue({
      data: {
        user: {
          id: 'staff-1',
          email: 'staff@example.com',
        },
      },
      error: null,
    })
  })

  it('creates staff with branch and Purchases permission in one admin request', async () => {
    await createStaffUser({
      fullName: 'Ama Mensah',
      email: 'AMA@EXAMPLE.COM',
      phone: '0240000000',
      role: 'procurement',
      branchId: 'branch-1',
      temporaryPassword: 'Temporary123',
      canRefund: false,
      canManageInventory: true,
      canViewReports: true,
      canManageClaims: false,
      canManagePurchases: true,
      canProcessSales: false,
      canManagePatients: false,
      canManageAccounting: false,
      canManageEpharmacy: true,
      canViewActivityLog: false,
      canAdjustStock: true,
      canApprovePurchases: false,
    })

    expect(invokeSupabaseFunction).toHaveBeenCalledWith('staff-admin', {
      body: expect.objectContaining({
        action: 'upsert_staff_user',
        email: 'ama@example.com',
        branchId: 'branch-1',
        canManageInventory: true,
        canManagePurchases: true,
        canManageEpharmacy: true,
        canAdjustStock: true,
        password: 'Temporary123',
      }),
    })
  })

  it('updates identity, access, status, branch, and an optional reset password', async () => {
    await updateStaffUser('staff-1', {
      fullName: 'Kofi Owusu',
      email: 'KOFI@EXAMPLE.COM',
      phone: '',
      role: 'assistant',
      branchId: 'branch-2',
      temporaryPassword: 'ResetPass123',
      isActive: false,
      canRefund: true,
      canManageInventory: false,
      canViewReports: true,
      canManageClaims: true,
      canManagePurchases: false,
      canProcessSales: true,
      canManagePatients: true,
      canManageAccounting: false,
      canManageEpharmacy: false,
      canViewActivityLog: false,
      canAdjustStock: false,
      canApprovePurchases: false,
    })

    expect(invokeSupabaseFunction).toHaveBeenCalledWith('staff-admin', {
      body: {
        action: 'update_staff_access',
        userId: 'staff-1',
        fullName: 'Kofi Owusu',
        email: 'kofi@example.com',
        phone: null,
        role: 'assistant',
        branchId: 'branch-2',
        isActive: false,
        canRefund: true,
        canManageInventory: false,
        canViewReports: true,
        canManageClaims: true,
        canManagePurchases: false,
        canProcessSales: true,
        canManagePatients: true,
        canManageAccounting: false,
        canManageEpharmacy: false,
        canViewActivityLog: false,
        canAdjustStock: false,
        canApprovePurchases: false,
        password: 'ResetPass123',
      },
    })
  })

  it('does not reset the password when the edit field is left blank', async () => {
    await updateStaffUser('staff-1', {
      fullName: 'Kofi Owusu',
      email: 'kofi@example.com',
      role: 'assistant',
      branchId: '',
      temporaryPassword: '',
      isActive: true,
    })

    const request = invokeSupabaseFunction.mock.calls[0][1].body
    expect(request.password).toBeUndefined()
    expect(request.branchId).toBeNull()
  })

  it('blocks short reset passwords before calling the admin function', async () => {
    await expect(
      updateStaffUser('staff-1', {
        fullName: 'Kofi Owusu',
        email: 'kofi@example.com',
        role: 'assistant',
        temporaryPassword: 'short',
        isActive: true,
      })
    ).rejects.toThrow('Temporary password must be at least 8 characters.')

    expect(invokeSupabaseFunction).not.toHaveBeenCalled()
  })
})
