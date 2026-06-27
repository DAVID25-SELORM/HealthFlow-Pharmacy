import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createBranchSale: vi.fn(),
  getBranchRecentSales: vi.fn(),
  getBranchSale: vi.fn(),
  createSale: vi.fn(),
  getRecentSales: vi.fn(),
  getSaleById: vi.fn(),
  refundSale: vi.fn(),
}))

vi.mock('./branchServerApi', () => ({
  createBranchSale: mocks.createBranchSale,
  getBranchRecentSales: mocks.getBranchRecentSales,
  getBranchSale: mocks.getBranchSale,
}))

vi.mock('./salesService', () => ({
  createSale: mocks.createSale,
  getRecentSales: mocks.getRecentSales,
  getSaleById: mocks.getSaleById,
  refundSale: mocks.refundSale,
}))

import {
  createPosSale,
  getPosRecentSales,
  getPosSaleById,
  refundPosSale,
} from './salesApi'

describe('salesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes cloud and branch sales through one boundary', async () => {
    await createPosSale({ items: [1] })
    await createPosSale({ items: [2] }, { useBranch: true })
    await getPosRecentSales(5)
    await getPosRecentSales(6, { useBranch: true })
    await getPosSaleById('cloud-sale')
    await getPosSaleById('branch-sale', { useBranch: true })

    expect(mocks.createSale).toHaveBeenCalledWith({ items: [1] })
    expect(mocks.createBranchSale).toHaveBeenCalledWith({ items: [2] })
    expect(mocks.getRecentSales).toHaveBeenCalledWith(5)
    expect(mocks.getBranchRecentSales).toHaveBeenCalledWith(6)
    expect(mocks.getSaleById).toHaveBeenCalledWith('cloud-sale')
    expect(mocks.getBranchSale).toHaveBeenCalledWith('branch-sale')
  })

  it('keeps refunds on the hardened cloud transaction', async () => {
    await refundPosSale({ saleId: 'sale-1' })
    expect(mocks.refundSale).toHaveBeenCalledWith({ saleId: 'sale-1' })
  })
})
