const text = (value) => String(value ?? '').trim()

const nonNegativeNumber = (value, label) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a valid non-negative number.`)
  }
  return parsed
}

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100

const isActiveCatalogRow = (row) =>
  ![false, 0, '0', 'false'].includes(row?.is_active)

export const applyNhisCatalogPricing = (claim = {}, catalogRows = []) => {
  const byId = new Map()
  const byCode = new Map()

  for (const row of catalogRows) {
    if (!isActiveCatalogRow(row)) continue
    const id = text(row?.id)
    const code = text(row?.code).toUpperCase()
    if (id) byId.set(id, row)
    if (code) byCode.set(code, row)
  }

  const medicines = Array.isArray(claim.nhis_claim_medicines)
    ? claim.nhis_claim_medicines
    : []

  const pricedMedicines = medicines.map((medicine, index) => {
    const id = text(medicine.nhis_drug_id ?? medicine.nhisDrugId)
    const code = text(
      medicine.drug_code ?? medicine.drugCode ?? medicine.nhis_code ?? medicine.nhisCode
    ).toUpperCase()
    const catalogDrug = (id && byId.get(id)) || (code && byCode.get(code))

    if (!catalogDrug) {
      throw new Error(`Medicine ${index + 1} must match an active NHIS catalog item.`)
    }

    const quantity = nonNegativeNumber(
      medicine.dispensed_qty ?? medicine.dispensedQty ?? medicine.served_qty ?? medicine.servedQty,
      `Medicine ${index + 1} quantity`
    )
    const unitPrice = nonNegativeNumber(catalogDrug.unit_price, `Medicine ${index + 1} catalog price`)

    return {
      ...medicine,
      nhis_drug_id: catalogDrug.id,
      drug_code: catalogDrug.code,
      description: catalogDrug.description,
      unit: catalogDrug.unit || 'unit',
      unit_price: unitPrice,
      dispensed_qty: quantity,
      total_amount: money(unitPrice * quantity),
    }
  })

  const services = Array.isArray(claim.nhis_claim_services) ? claim.nhis_claim_services : []
  const medicineTotal = pricedMedicines.reduce((sum, medicine) => sum + Number(medicine.total_amount || 0), 0)
  const serviceTotal = services.reduce((sum, service) => sum + Number(service.total_amount || 0), 0)

  return {
    ...claim,
    nhis_claim_medicines: pricedMedicines,
    total_amount: money(medicineTotal + serviceTotal),
  }
}
