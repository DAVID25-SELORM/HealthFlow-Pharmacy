export const getInStockPosDrugs = (drugs = []) =>
  (Array.isArray(drugs) ? drugs : []).filter((drug) => {
    const quantity = Number.parseFloat(drug?.quantity)
    return Number.isFinite(quantity) && quantity > 0
  })
