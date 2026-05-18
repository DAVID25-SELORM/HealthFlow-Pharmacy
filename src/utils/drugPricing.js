export const getNhisCatalogPrice = (drug) => {
  const nhisPrice = Number.parseFloat(drug?.nhis_price)
  return Boolean(drug?.is_nhis_listed && Number.isFinite(nhisPrice) && nhisPrice > 0)
    ? nhisPrice
    : 0
}

export const getEffectiveSellingPrice = (drug) => {
  const price = Number.parseFloat(drug?.price)
  if (Number.isFinite(price) && price > 0) {
    return price
  }

  const nhisPrice = getNhisCatalogPrice(drug)
  if (nhisPrice > 0) {
    return nhisPrice
  }

  return Number.isFinite(price) ? price : 0
}

export const hasNhisCatalogPrice = (drug) => getNhisCatalogPrice(drug) > 0
