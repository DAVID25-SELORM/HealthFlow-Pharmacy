import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeTierAccess, fromMock } = vi.hoisted(() => ({
  invokeTierAccess: vi.fn(),
  fromMock: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}))

import {
  calculateDrugStatus,
  getAllDrugs,
  isDefaultCatalogDrug,
  updateDrug,
  deleteDrug,
} from './drugService'

describe('drugService catalog handling', () => {
  beforeEach(() => {
    invokeTierAccess.mockReset()
    fromMock.mockReset()
  })

  it('identifies shared catalog medicines by reserved batch prefix', () => {
    expect(isDefaultCatalogDrug({ batch_number: 'PDF-IMP-00001' })).toBe(true)
    expect(isDefaultCatalogDrug({ batch_number: 'BT-001' })).toBe(false)
  })

  it('marks zero-quantity shared catalog medicines as catalog items', () => {
    expect(
      calculateDrugStatus({
        batch_number: 'PDF-IMP-00001',
        quantity: 0,
        expiry_date: '2028-12-31',
      })
    ).toBe('catalog')
  })

  it('filters out zero-quantity catalog medicines outside inventory views', async () => {
    invokeTierAccess.mockResolvedValue({
      drugs: [
        { id: 'catalog-hidden', name: 'Catalog Hidden', batch_number: 'PDF-IMP-00001', quantity: 0 },
        { id: 'catalog-stocked', name: 'Catalog Stocked', batch_number: 'PDF-IMP-00002', quantity: 6 },
        { id: 'custom-drug', name: 'Custom Drug', batch_number: 'BT-001', quantity: 0 },
      ],
    })

    await expect(getAllDrugs()).resolves.toEqual([
      { id: 'catalog-stocked', name: 'Catalog Stocked', batch_number: 'PDF-IMP-00002', quantity: 6 },
      { id: 'custom-drug', name: 'Custom Drug', batch_number: 'BT-001', quantity: 0 },
    ])
  })

  it('falls back to a direct drugs query when tier-access read fails', async () => {
    const queryBuilder = {
      select: vi.fn(),
      order: vi.fn(),
    }

    queryBuilder.select.mockReturnValue(queryBuilder)
    queryBuilder.order.mockResolvedValue({
      data: [
        {
          id: 'inactive-drug',
          name: 'Inactive Drug',
          batch_number: 'BT-000',
          quantity: 3,
          status: 'inactive',
        },
        {
          id: 'catalog-hidden',
          name: 'Catalog Hidden',
          batch_number: 'PDF-IMP-00001',
          quantity: 0,
          status: 'active',
        },
        {
          id: 'custom-drug',
          name: 'Custom Drug',
          batch_number: 'BT-001',
          quantity: 5,
          status: 'active',
        },
      ],
      error: null,
    })

    invokeTierAccess.mockRejectedValue(new Error('Unexpected tier access error.'))
    fromMock.mockReturnValue(queryBuilder)

    await expect(getAllDrugs()).resolves.toEqual([
      {
        id: 'custom-drug',
        name: 'Custom Drug',
        batch_number: 'BT-001',
        quantity: 5,
        status: 'active',
      },
    ])

    expect(fromMock).toHaveBeenCalledWith('drugs')
    expect(queryBuilder.select).toHaveBeenCalledWith('*')
    expect(queryBuilder.order).toHaveBeenCalledWith('name')
  })

  it('routes updates and deletes through tier-access actions', async () => {
    invokeTierAccess
      .mockResolvedValueOnce({ drug: { id: 'drug-1', quantity: 5 } })
      .mockResolvedValueOnce({ drug: { id: 'drug-1', status: 'inactive' } })

    await updateDrug('drug-1', {
      name: 'Paracetamol 500mg',
      batchNumber: 'BT-001',
      expiryDate: '2028-12-31',
      quantity: 5,
      price: 12,
      supplier: 'Supplier',
    })

    await deleteDrug('drug-1')

    expect(invokeTierAccess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'update_drug',
        drugId: 'drug-1',
      })
    )

    expect(invokeTierAccess).toHaveBeenNthCalledWith(2, {
      action: 'delete_drug',
      drugId: 'drug-1',
    })
  })
})
