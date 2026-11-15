import { NHIS_TOP_UP_POLICIES, isNhisSettlementEligible, normalizeNhisTopUpPolicy } from './nhisSplitSettlement'

// NHIS-009: a pharmacy whose NHIS top-up policy is "not allowed" sells only NHIS catalogue
// medicines under an NHIS sale, at the catalogue amount. Medicines that are not on the NHIS
// catalogue never appear while NHIS is selected; if they were already in the cart they are
// kept aside for a separate cash sale and come back afterwards.
//
// A pharmacy that allows top-ups (or requires them when NHIS is below the selling value) is not
// affected: these helpers are only used when isNhisCatalogueOnlyPolicy() is true.

const money = (value) => Math.round((Number(value) || 0) * 100) / 100

export const isNhisCatalogueOnlyPolicy = ({ topUpPolicy, legacyTopUpsEnabled = false } = {}) =>
  normalizeNhisTopUpPolicy(topUpPolicy, { legacyTopUpsEnabled }) === NHIS_TOP_UP_POLICIES.NOT_ALLOWED

// A stocked medicine on the NHIS catalogue: it has an NHIS code and a usable tariff, the same
// test the settlement uses to cover a line. `tariff` is the drug's catalogue price.
export const isNhisCatalogueDrug = (drug, tariff) =>
  isNhisSettlementEligible({ nhisCode: drug?.nhis_code, nhisPrice: tariff })

// The same test for a cart line (the cart keeps nhisCode and nhisPrice only for catalogue medicines).
export const isNhisCatalogueCartItem = (item) => isNhisSettlementEligible(item)

const retailPriceOf = (item) => Number(item?.retailPrice ?? item?.price) || 0

const mergeLines = (base, extra) => {
  const merged = base.map((line) => ({ ...line }))
  for (const line of extra) {
    const index = merged.findIndex((existing) => existing.id === line.id)
    if (index === -1) {
      merged.push({ ...line })
      continue
    }
    const available = Number(merged[index].available ?? line.available)
    const sum = Number(merged[index].quantity || 0) + Number(line.quantity || 0)
    merged[index] = { ...merged[index], quantity: Number.isFinite(available) && available > 0 ? Math.min(sum, available) : sum }
  }
  return merged
}

// The cashier switches to NHIS. Catalogue lines stay in the cart and are priced at the catalogue
// amount (the normal selling price is remembered as retailPrice). Every other line is taken out of
// the cart and kept for a cash sale, with its normal selling price.
export const moveCartToNhis = (cart = [], held = []) => {
  const nhisLines = []
  const keptForCash = []
  for (const item of Array.isArray(cart) ? cart : []) {
    if (isNhisCatalogueCartItem(item)) {
      nhisLines.push({ ...item, retailPrice: retailPriceOf(item), price: money(item.nhisPrice) })
    } else {
      keptForCash.push({ ...item, price: retailPriceOf(item) })
    }
  }
  return {
    cart: nhisLines,
    held: mergeLines(Array.isArray(held) ? held : [], keptForCash),
    keptNames: keptForCash.map((item) => item.name),
  }
}

// The cashier leaves NHIS (or the sale is finished). Catalogue lines go back to their normal
// selling price and the lines kept for cash return to the cart.
export const moveCartFromNhis = (cart = [], held = []) => {
  const restoredLines = (Array.isArray(cart) ? cart : []).map((item) => ({ ...item, price: retailPriceOf(item) }))
  const heldLines = Array.isArray(held) ? held : []
  return {
    cart: mergeLines(restoredLines, heldLines),
    restoredNames: heldLines.map((item) => item.name),
  }
}

export const NHIS_CATALOGUE_ONLY_LIST_NOTE =
  'NHIS sale: only NHIS catalogue medicines are shown, at the catalogue amount. Other medicines are sold as a separate cash sale.'

export const getNhisCatalogueOnlyNotListedMessage = (name = 'This medicine') =>
  `${name} is not on the NHIS list. Sell it as a separate cash sale.`
