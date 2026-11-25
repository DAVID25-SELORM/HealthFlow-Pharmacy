// Which served quantities has an edit lowered or removed, compared with the saved claim?
// The database asks for a reason when this returns stock to the shelf, so the claim form asks first.

const toText = (value) => String(value ?? '').trim()

// Same medicine key as the database: catalogue ID first, then the NHIS drug code.
const getMedicineKey = (line) => {
  const catalogId = toText(line.nhisDrugId ?? line.nhis_drug_id).toLowerCase()
  if (catalogId) return catalogId
  const code = toText(line.drugCode ?? line.drug_code).toUpperCase()
  return code || toText(line.description).toLowerCase()
}

const getServedQty = (line) =>
  Number(line.servedQty ?? line.served_qty ?? line.dispensedQty ?? line.dispensed_qty ?? 0) || 0

// Two lines of the same medicine count together, as they do when stock is taken.
const totalByMedicine = (lines) => {
  const totals = new Map()
  for (const line of lines || []) {
    if (!line) continue
    const key = getMedicineKey(line)
    if (!key) continue
    const current = totals.get(key) || { key, description: toText(line.description), quantity: 0 }
    current.quantity += getServedQty(line)
    totals.set(key, current)
  }
  return totals
}

export const getNhisServedReductions = (savedLines, editedLines) => {
  const edited = totalByMedicine(editedLines)
  const reductions = []
  for (const saved of totalByMedicine(savedLines).values()) {
    const now = edited.get(saved.key)
    const to = now ? now.quantity : 0
    if (saved.quantity - to > 0.000001) {
      reductions.push({
        key: saved.key,
        description: saved.description || 'Medicine',
        from: saved.quantity,
        to,
        removed: !now,
      })
    }
  }
  return reductions
}

export const NHIS_REDUCTION_REASONS = [
  'Typed the wrong quantity',
  'Patient did not collect all',
  'Medicine was not given',
]

export const NHIS_REDUCTION_REASON_PROMPT =
  'The served quantity was lowered. Choose a reason in the box at the bottom, then save again.'

export const isServedReductionReasonError = (message) =>
  /reason is required to reduce or remove a served nhis quantity/i.test(String(message || ''))
