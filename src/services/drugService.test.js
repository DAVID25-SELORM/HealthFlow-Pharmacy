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

  const createDirectDrugQuery = (rows) => {
    const queryBuilder = {
      select: vi.fn(),
      order: vi.fn(),
    }

    queryBuilder.select.mockReturnValue(queryBuilder)
    queryBuilder.order.mockResolvedValue({
      data: rows,
      error: null,
    })

    fromMock.mockReturnValue(queryBuilder)
    return queryBuilder
  }

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
    createDirectDrugQuery([
      { id: 'catalog-hidden', name: 'Catalog Hidden', batch_number: 'PDF-IMP-00001', quantity: 0 },
      { id: 'catalog-stocked', name: 'Catalog Stocked', batch_number: 'PDF-IMP-00002', quantity: 6 },
      { id: 'custom-drug', name: 'Custom Drug', batch_number: 'BT-001', quantity: 0 },
    ])

    await expect(getAllDrugs()).resolves.toEqual([
      { id: 'catalog-stocked', name: 'Catalog Stocked', batch_number: 'PDF-IMP-00002', quantity: 6 },
      { id: 'custom-drug', name: 'Custom Drug', batch_number: 'BT-001', quantity: 0 },
    ])
  })

  it('loads drugs directly without invoking tier-access for read-only listings', async () => {
    const queryBuilder = createDirectDrugQuery([
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
    ])

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
    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('uses tier-access for catalog-aware inventory loads', async () => {
    invokeTierAccess.mockResolvedValue({
      drugs: [
        {
          id: 'catalog-stocked',
          name: 'Catalog Stocked',
          batch_number: 'PDF-IMP-00001',
          quantity: 0,
          status: 'active',
        },
      ],
    })

    await expect(getAllDrugs({ includeCatalog: true })).resolves.toEqual([
      {
        id: 'catalog-stocked',
        name: 'Catalog Stocked',
        batch_number: 'PDF-IMP-00001',
        quantity: 0,
        status: 'active',
      },
    ])

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'get_drugs',
      includeCatalog: true,
    })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('surfaces tier-access failures for catalog-aware inventory loads', async () => {
    const tierAccessError = new Error(
      'duplicate key value violates unique constraint "drugs_name_batch_number_key"'
    )
    invokeTierAccess.mockRejectedValue(tierAccessError)

    await expect(getAllDrugs({ includeCatalog: true })).rejects.toThrow(tierAccessError.message)

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'get_drugs',
      includeCatalog: true,
    })
    expect(fromMock).not.toHaveBeenCalled()
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
