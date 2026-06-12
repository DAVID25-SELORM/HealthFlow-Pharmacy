export const getNhiaMemberLookupFailureMessage = (memberDetails) => {
  const status = String(memberDetails?.status || '').trim()
  if (!memberDetails || memberDetails.ccCode || !status) return ''
  if (status.toLowerCase() === 'inactive') {
    return 'Member details were found, but the NHIS membership is currently inactive. A CC code cannot be generated. Please ask the member to contact NHIA or renew their membership.'
  }
  return `NHIA member lookup did not return a CC code: ${status}.`
}
