import {
  createBranchSale,
  getBranchRecentSales,
  getBranchSale,
} from './branchServerApi'
import {
  createSale,
  getRecentSales,
  getSaleById,
  refundSale,
} from './salesService'

export const createPosSale = async (salePayload, { useBranch = false } = {}) =>
  useBranch ? createBranchSale(salePayload) : createSale(salePayload)

export const getPosRecentSales = async (limit = 8, { useBranch = false } = {}) =>
  useBranch ? getBranchRecentSales(limit) : getRecentSales(limit)

export const getPosSaleById = async (saleId, { useBranch = false } = {}) =>
  useBranch ? getBranchSale(saleId) : getSaleById(saleId)

export const refundPosSale = async (refundPayload) => refundSale(refundPayload)
