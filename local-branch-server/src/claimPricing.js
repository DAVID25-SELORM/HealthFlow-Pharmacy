const toFiniteNumber = (value, label) => {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a valid number.`)
  }
  return number
}

export const calculateClaimLine = ({
  quantity,
  unitPrice,
  quantityLabel = 'Claim line quantity',
  priceLabel = 'Claim line unit price',
} = {}) => {
  const normalizedQuantity = toFiniteNumber(quantity, quantityLabel)
  const normalizedUnitPrice = toFiniteNumber(unitPrice, priceLabel)
  if (normalizedQuantity <= 0) throw new Error(`${quantityLabel} must be greater than zero.`)
  if (normalizedUnitPrice < 0) throw new Error(`${priceLabel} cannot be negative.`)

  return {
    quantity: normalizedQuantity,
    unitPrice: Math.round(normalizedUnitPrice * 100) / 100,
    totalPrice: Math.round(normalizedQuantity * normalizedUnitPrice * 100) / 100,
  }
}

export const normalizePharmacyClaimLines = ({
  medicines = [],
  services = [],
  isHospital = false,
} = {}) => {
  const normalizedMedicines = medicines.map((medicine) => ({
    ...medicine,
    ...calculateClaimLine({
      quantity: medicine.quantity,
      unitPrice: medicine.unitPrice ?? medicine.unit_price ?? medicine.price,
      quantityLabel: 'Medicine quantity',
      priceLabel: 'Medicine unit price',
    }),
  }))
  const normalizedServices = isHospital
    ? services.map((service) => {
        const calculated = calculateClaimLine({
          quantity: service.quantity ?? 1,
          unitPrice: service.unitPrice ?? service.unit_price,
          quantityLabel: 'Service quantity',
          priceLabel: 'Service unit price',
        })
        return {
          ...service,
          ...calculated,
          totalAmount: calculated.totalPrice,
        }
      })
    : []

  return {
    medicines: normalizedMedicines,
    services: normalizedServices,
    totalAmount: [...normalizedMedicines, ...normalizedServices]
      .reduce((sum, line) => Math.round((sum + line.totalPrice) * 100) / 100, 0),
  }
}
