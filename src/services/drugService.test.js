import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeTierAccess, fromMock, getBranchInventory, deleteBranchInventoryDrug, routeReadMock, routeWriteMock } = vi.hoisted(() => ({
  invokeTierAccess: vi.fn(),
  fromMock: vi.fn(),
  getBranchInventory: vi.fn(),
  deleteBranchInventoryDrug: vi.fn(),
  routeReadMock: vi.fn(),
  routeWriteMock: vi.fn(),
}))

vi.mock('./tierAccessService', () => ({
  invokeTierAccess,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}))

vi.mock('./branchServerApi', () => ({
  getBranchInventory,
  deleteBranchInventoryDrug,
}))

vi.mock('./apiRouter', () => ({
  routeRead: routeReadMock,
  routeWrite: routeWriteMock,
}))

import {
  calculateDrugStatus,
  addDrug,
  getAllDrugs,
  isDefaultCatalogDrug,
  searchDrugs,
  updateDrug,
  deleteDrug,
} from './drugService'

describe('drugService catalog handling', () => {
  beforeEach(() => {
    invokeTierAccess.mockReset()
    fromMock.mockReset()
    getBranchInventory.mockReset()
    deleteBranchInventoryDrug.mockReset()
    routeReadMock.mockReset()
    routeWriteMock.mockReset()
    routeReadMock.mockImplementation(({ cloud }) => cloud())
    routeWriteMock.mockImplementation(({ cloud }) => cloud())
  })

  const createDirectDrugQuery = (rows) => {
    const queryBuilder = {
      select: vi.fn(),
      order: vi.fn(),
      range: vi.fn(),
    }

    queryBuilder.select.mockReturnValue(queryBuilder)
    queryBuilder.order.mockReturnValue(queryBuilder)
    queryBuilder.range.mockResolvedValue({
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
    expect(queryBuilder.order).toHaveBeenCalledWith('id')
    expect(queryBuilder.range).toHaveBeenCalledWith(0, 999)
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

  it('rejects script-like drug names before saving', async () => {
    await expect(addDrug({
      name: '<script>alert(1)</script>',
      expiryDate: '2026-12-31',
      quantity: 10,
      price: 5,
    })).rejects.toThrow('Drug name cannot contain HTML or script characters.')

    expect(invokeTierAccess).not.toHaveBeenCalled()
  })

  it('does not pass hosted branch ids into local branch inventory reads', async () => {
    const localRows = [
      {
        id: 'local-branch-stock',
        name: 'Anastrazole 1mg',
        branch_id: 'local-branch-id',
        quantity: 20,
      },
      {
        id: 'unassigned-local-stock',
        name: 'Paracetamol Verify',
        branch_id: null,
        quantity: 5,
      },
    ]
    routeReadMock.mockImplementationOnce(({ local }) => local())
    getBranchInventory.mockResolvedValueOnce(localRows)

    await expect(
      getAllDrugs({ includeCatalog: true, branchId: 'hosted-browser-branch-id' })
    ).resolves.toEqual(localRows)

    expect(getBranchInventory).toHaveBeenCalledWith({ limit: 20000 })
    expect(invokeTierAccess).not.toHaveBeenCalled()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('uses tier-access for POS-friendly reads when requested', async () => {
    invokeTierAccess.mockResolvedValue({
      drugs: [
        {
          id: 'tier-drug',
          name: 'Tier Drug',
          batch_number: 'BT-777',
          quantity: 9,
          status: 'active',
        },
      ],
    })

    await expect(getAllDrugs({ useTierAccess: true })).resolves.toEqual([
      {
        id: 'tier-drug',
        name: 'Tier Drug',
        batch_number: 'BT-777',
        quantity: 9,
        status: 'active',
      },
    ])

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'get_drugs',
      includeCatalog: false,
    })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('uses tier-access for bounded POS search results', async () => {
    invokeTierAccess.mockResolvedValue({
      drugs: [
        {
          id: 'match-1',
          name: 'Amoxicillin',
          batch_number: 'AMX-001',
          quantity: 12,
          status: 'active',
        },
      ],
    })

    await expect(
      searchDrugs('amox', {
        useTierAccess: true,
        inStockOnly: true,
        limit: 30,
      })
    ).resolves.toEqual([
      {
        id: 'match-1',
        name: 'Amoxicillin',
        batch_number: 'AMX-001',
        quantity: 12,
        status: 'active',
      },
    ])

    expect(invokeTierAccess).toHaveBeenCalledWith({
      action: 'get_drugs',
      includeCatalog: false,
      searchTerm: 'amox',
      limit: 30,
      inStockOnly: true,
    })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('filters tier-access search results on the client for old deployed functions', async () => {
    invokeTierAccess.mockResolvedValue({
      drugs: [
        {
          id: 'match-1',
          name: 'Lydia Emergency Contraceptive',
          batch_number: 'LYD-001',
          quantity: 5,
          status: 'active',
        },
        {
          id: 'other-1',
          name: 'Paracetamol',
          batch_number: 'PAR-001',
          quantity: 20,
          status: 'active',
        },
      ],
    })

    await expect(
      searchDrugs('Lydia pill', {
        useTierAccess: true,
        inStockOnly: true,
        limit: 30,
      })
    ).resolves.toEqual([
      {
        id: 'match-1',
        name: 'Lydia Emergency Contraceptive',
        batch_number: 'LYD-001',
        quantity: 5,
        status: 'active',
      },
    ])
  })

  it('retries multi-word tier-access search with the first token when exact search returns nothing', async () => {
    invokeTierAccess
      .mockResolvedValueOnce({ drugs: [] })
      .mockResolvedValueOnce({
        drugs: [
          {
            id: 'match-1',
            name: 'Lydia Emergency Contraceptive',
            batch_number: 'LYD-001',
            quantity: 5,
            status: 'active',
          },
        ],
      })

    await expect(
      searchDrugs('Lydia pill', {
        useTierAccess: true,
        inStockOnly: true,
        limit: 30,
      })
    ).resolves.toEqual([
      {
        id: 'match-1',
        name: 'Lydia Emergency Contraceptive',
        batch_number: 'LYD-001',
        quantity: 5,
        status: 'active',
      },
    ])

    expect(invokeTierAccess).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        searchTerm: 'lydia',
      })
    )
  })

  it('returns the updated existing active drug when add resolves a duplicate', async () => {
    invokeTierAccess.mockResolvedValue({
      action: 'update_existing',
      drug: {
        id: 'existing-drug',
        name: 'Paracetamol 500mg',
        batch_number: 'BT-001',
        quantity: 12,
        status: 'active',
      },
    })

    await expect(
      addDrug({
        name: 'Paracetamol 500mg',
        batchNumber: 'BT-001',
        expiryDate: '2028-12-31',
        quantity: 12,
        price: 5,
      })
    ).resolves.toEqual({
      id: 'existing-drug',
      name: 'Paracetamol 500mg',
      batch_number: 'BT-001',
      quantity: 12,
      status: 'active',
      _saveAction: 'update_existing',
    })
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
