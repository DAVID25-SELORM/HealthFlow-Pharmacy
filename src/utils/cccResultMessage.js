const providerNames = {
  api: 'Existing NHIA API',
  existing: 'Existing NHIA API',
  nehfams: 'NHIA NeHFAMS',
  otac: 'NHIA OTAC',
  claimit_bridge: 'CLAIM-it',
}

export function cccProviderName(provider) {
  return providerNames[provider] || 'NHIA'
}

export function cccResultMessage(result = {}) {
  const provider = cccProviderName(result.source)
  if (result.reused === true) {
    return `Saved CCC reused from an earlier confirmed attendance (${provider}). No new request was sent to NHIA.`
  }
  if (result.memberDetails?.newCcc === false) {
    return `${provider} confirmed the existing CCC for this attendance.`
  }
  return `CCC received from ${provider}.`
}
