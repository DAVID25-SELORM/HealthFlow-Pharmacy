// Reorder Centre phase 4: advisory branch-transfer options. Nothing here moves stock; a transfer
// only happens when a person confirms it, through the existing transfer_drug_to_branch().

const num = (value) => Number.parseFloat(value) || 0

// Options come from get_branch_transfer_options, largest spare first. "Spare" is stock above the
// source row's own reorder level, so a transfer never pushes the source branch into low stock.
export const summarizeTransferAdvice = (options, suggestedQuantity = 0) => {
  const list = (options || []).filter((option) => num(option.spare_quantity) > 0)
  if (list.length === 0) return null
  const best = list[0]
  const totalSpare = list.reduce((sum, option) => sum + num(option.spare_quantity), 0)
  const suggested = num(suggestedQuantity)
  const sources = new Set(list.map((option) => option.source_branch_name))
  const branchText = sources.size === 1 ? best.source_branch_name : `${best.source_branch_name} and ${sources.size - 1} other branch${sources.size - 1 === 1 ? '' : 'es'}`
  return {
    best,
    options: list,
    totalSpare,
    coversSuggestion: suggested > 0 && totalSpare >= suggested,
    message: `${branchText} ${sources.size === 1 ? 'has' : 'have'} ${totalSpare} spare`,
  }
}

// Default to what is needed, but never more than the chosen source has to spare.
export const defaultTransferQuantity = (option, suggestedQuantity) => {
  const spare = num(option?.spare_quantity)
  const wanted = num(suggestedQuantity)
  return String(wanted > 0 ? Math.min(spare, wanted) : spare)
}

export const validateTransferQuantity = (quantity, option) => {
  const value = Number.parseFloat(quantity)
  if (!option) return 'Choose which branch to transfer from.'
  if (!Number.isFinite(value) || value <= 0) return 'Enter a quantity above zero.'
  const spare = num(option.spare_quantity)
  if (value > spare) {
    return `${option.source_branch_name} only has ${spare} spare (stock above its own reorder level).`
  }
  return ''
}

export const describeTransferSource = (option) =>
  [
    option.source_branch_name,
    option.batch_number ? `batch ${option.batch_number}` : null,
    option.expiry_date ? `expires ${String(option.expiry_date).slice(0, 10)}` : null,
  ].filter(Boolean).join(' · ')
