import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUserBranchIdsByUserIds: vi.fn(),
  recordCashbookMovementIfSessionOpen: vi.fn(),
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

import { createSale } from './salesService'

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
      })
    ).rejects.toEqual(rpcError)

    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('falls back to the legacy sale flow only when the sale RPC is missing', async () => {
    const salesSelect = vi.fn().mockResolvedValue({
      data: [{ id: 'sale-1', sale_number: 'SAL-000123' }],
      error: null,
    })
    const salesInsert = vi.fn(() => ({
      select: salesSelect,
    }))
    const saleItemsInsert = vi.fn().mockResolvedValue({
      error: null,
    })

    mocks.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.create_sale_transaction(jsonb).',
        },
      })
      .mockResolvedValueOnce({
        data: 'SAL-000123',
        error: null,
      })

    mocks.from.mockImplementation((table) => {
      if (table === 'sales') {
        return {
          insert: salesInsert,
        }
      }

      if (table === 'sale_items') {
        return {
          insert: saleItemsInsert,
        }
      }

      throw new Error(`Unexpected table: ${table}`)
    })

    await expect(
      createSale({
        items: [
          { drugId: 'drug-1', name: 'Paracetamol 500mg', quantity: 2, price: 12.5 },
        ],
        paymentMethod: 'card',
        amountPaid: 0,
        soldBy: 'user-1',
      })
    ).resolves.toEqual({
      sale: {
        id: 'sale-1',
        sale_number: 'SAL-000123',
      },
      saleNumber: 'SAL-000123',
    })

    expect(salesInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        payment_method: 'card',
        amount_paid: 25,
        change_given: 0,
      }),
    ])
    expect(saleItemsInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        quantity: 2,
        unit_price: 12.5,
        total_price: 25,
      }),
    ])
    expect(mocks.tryLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sale.completed',
      })
    )
  })
})
