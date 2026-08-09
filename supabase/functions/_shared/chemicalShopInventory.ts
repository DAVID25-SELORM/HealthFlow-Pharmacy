const normalize = (value: unknown) => typeof value === 'string' ? value.trim() : ''

export const isChemicalShopOrganizationType = (value: unknown) =>
  normalize(value).toLowerCase() === 'chemical_shop'

export const isChemicalShopMedicineAllowed = (drug: Record<string, unknown>) => {
  const accessLevel = normalize(drug.medicine_access_level).toUpperCase()
  const saleClass = normalize(drug.epharmacy_sale_class).toLowerCase()

  return (
    (accessLevel === 'OTC' || drug.chemical_shop_sale_permitted === true) &&
    !['prescription', 'restricted', 'controlled', 'narcotic'].includes(saleClass)
  )
}
