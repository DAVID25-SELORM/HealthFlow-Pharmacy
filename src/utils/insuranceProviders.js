export const INSURANCE_PROVIDERS = [
  'NHIS',
  'Acacia Health Insurance',
  'ACE Insurance',
  'Allianz Insurance',
  'AMC Care Foundation',
  'Apex Health Insurance',
  'Apex Care Limited',
  'Cosmo Health Insurance',
  'Equity Health Insurance',
  'GHIC / GAB Health Insurance',
  'GLICO Healthcare',
  'EmPLE Health Insurance Ghana Ltd.',
  'MyHealth Limited',
  'Nationwide Medical Insurance',
  'Phoenix Health Insurance',
  'Premier Health Insurance',
  'Star Health Insurance',
  'MedFocus Health Insurance',
  'OneHealth Insurance',
  'Rivia Health Insurance',
]

export const getInsuranceProviderOptions = (currentValue = '') => {
  const normalizedCurrent = String(currentValue || '').trim()
  if (
    !normalizedCurrent ||
    INSURANCE_PROVIDERS.some(
      (provider) => provider.toLowerCase() === normalizedCurrent.toLowerCase()
    )
  ) {
    return INSURANCE_PROVIDERS
  }

  return [normalizedCurrent, ...INSURANCE_PROVIDERS]
}

