import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUserBranchIdsByUserIds: vi.fn(),
  recordCashbookMovementIfSessionOpen: vi.fn(),
  addShiftMovement: vi.fn(),
  rpc: vi.fn(),
  tryLogAuditEvent: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}))

vi.mock('./auditService', () => ({
  tryLogAuditEvent: mocks.tryLogAuditEvent,
}))

vi.mock('./branchService', () => ({
  getUserBranchIdsByUserIds: mocks.getUserBranchIdsByUserIds,
}))

vi.mock('./cashbookService', () => ({
  recordCashbookMovementIfSessionOpen: mocks.recordCashbookMovementIfSessionOpen,
}))

vi.mock('./shiftService', () => ({
  addShiftMovement: mocks.addShiftMovement,
}))

import { createSale, refundSale } from './salesService'

describe('salesService.createSale', () => {
  let errorSpy
  let warnSpy

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tryLogAuditEvent.mockResolvedValue(undefined)
    mocks.getUserBranchIdsByUserIds.mockResolvedValue({})
    mocks.recordCashbookMovementIfSessionOpen.mockResolvedValue(undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('rejects unsupported payment methods before calling Supabase', async () => {
    await expect(
      createSale({
        items: [{ drugId: 'drug-1', name: 'Paracetamol', quantity: 1, price: 12 }],
        paymentMethod: 'crypto',
        shiftId: 'shift-1',
      })
    ).rejects.toThrow('Payment method must be one of: cash, momo, insurance, card.')

    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('does not fall back to the legacy flow when the sale RPC fails with a real backend error', async () => {
    const rpcError = {
      code: '23514',
      message: 'Insufficient stock for Paracetamol 500mg.',
    }

    mocks.rpc.mockResolvedValue({
      data: null,
      error: rpcError,
    })

    await expect(
      createSale({
        items: [{ drugId: 'drug-1', name: 'Paracetamol 500mg', quantity: 2, price: 12 }],
        paymentMethod: 'cash',
        amountPaid: 24,
        shiftId: 'shift-1',
      })
    ).rejects.toEqual(rpcError)

    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('does not write sales directly when the secure sale RPC is missing', async () => {
    const rpcError = {
      code: 'PGRST202',
      message: 'Could not find the function public.create_sale_transaction(jsonb).',
    }

    mocks.rpc.mockResolvedValue({
      data: null,
      error: rpcError,
    })

    await expect(
      createSale({
        items: [{ drugId: 'drug-1', name: 'Paracetamol 500mg', quantity: 2, price: 12.5 }],
        paymentMethod: 'card',
        amountPaid: 0,
        soldBy: 'user-1',
        shiftId: 'shift-1',
      })
    ).rejects.toEqual(rpcError)

    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.tryLogAuditEvent).not.toHaveBeenCalled()
  })

  it('does not write sales directly when the secure sale RPC hits a sale number conflict', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "sales_sale_number_key"',
      },
    })

    await expect(
      createSale({
        items: [{ drugId: 'drug-1', name: 'Paracetamol 500mg', quantity: 1, price: 10 }],
        paymentMethod: 'cash',
        amountPaid: 10,
        soldBy: 'user-1',
        shiftId: 'shift-1',
      })
    ).rejects.toThrow('Sale number conflict. Please try completing the sale again.')

    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.tryLogAuditEvent).not.toHaveBeenCalled()
  })

  it('syncs cash patient top-ups from insurance sales to shift and cashbook', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        sale_id: 'sale-ins-1',
        sale_number: 'SAL-000555',
      },
      error: null,
    })
    mocks.getUserBranchIdsByUserIds.mockResolvedValue({
      'user-1': 'branch-1',
    })

    await expect(
      createSale({
        items: [{ drugId: 'drug-1', name: 'Insured Drug', quantity: 1, price: 100 }],
        patientId: 'patient-1',
        paymentMethod: 'insurance',
        soldBy: 'user-1',
        shiftId: 'shift-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        insuranceCoveredAmount: 70,
        insuranceTopUpAmount: 30,
        insuranceTopUpPaymentMethod: 'cash',
      })
    ).resolves.toEqual({
      sale: {
        id: 'sale-ins-1',
        sale_number: 'SAL-000555',
      },
      saleNumber: 'SAL-000555',
    })

    expect(mocks.rpc).toHaveBeenCalledWith('create_sale_transaction', {
      sale_payload: expect.objectContaining({
        payment_method: 'insurance',
        insurance_covered_amount: 70,
        insurance_top_up_amount: 30,
        insurance_top_up_payment_method: 'cash',
      }),
    })
    expect(mocks.recordCashbookMovementIfSessionOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-1',
        entryType: 'sale_cash',
        sourceType: 'sale',
        sourceId: 'sale-ins-1',
        amount: 30,
        direction: 'in',
        description: 'Insurance cash top-up SAL-000555',
      })
    )
    expect(mocks.addShiftMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        shiftId: 'shift-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        movementType: 'sale_cash',
        sourceType: 'sale',
        sourceId: 'sale-ins-1',
        amount: 30,
        direction: 'in',
        description: 'Insurance cash top-up SAL-000555',
      })
    )
  })
})

describe('salesService.refundSale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tryLogAuditEvent.mockResolvedValue(undefined)
  })

  it('rejects refunds for staff without refund permission', async () => {
    await expect(
      refundSale({
        saleId: 'sale-1',
        role: 'pharmacist',
        canRefund: false,
      })
    ).rejects.toThrow('Only admins or staff granted refund permission can process refunds.')

    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('calls refund_sale_transaction for pharmacy admin roles', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        sale_id: 'sale-1',
        sale_number: 'SAL-000321',
        payment_status: 'refunded',
      },
      error: null,
    })

    await expect(
      refundSale({
        saleId: 'sale-1',
        reason: 'Wrong bill',
        role: 'admin',
      })
    ).resolves.toEqual({
      sale_id: 'sale-1',
      sale_number: 'SAL-000321',
      payment_status: 'refunded',
    })

    expect(mocks.rpc).toHaveBeenCalledWith('refund_sale_transaction', {
      p_sale_id: 'sale-1',
      p_reason: 'Wrong bill',
    })
  })

  it('calls refund_sale_transaction for staff with refund permission', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        sale_id: 'sale-2',
        sale_number: 'SAL-000322',
        payment_status: 'refunded',
      },
      error: null,
    })

    await expect(
      refundSale({
        saleId: 'sale-2',
        role: 'assistant',
        canRefund: true,
      })
    ).resolves.toEqual({
      sale_id: 'sale-2',
      sale_number: 'SAL-000322',
      payment_status: 'refunded',
    })
  })
})
