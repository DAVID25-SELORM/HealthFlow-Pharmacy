import { getNhisCccTransitionIssue } from '../../local-branch-server/src/nhisCccValidation.js'

// NHIS-005: a valid 5-digit CCC/CC code is required to save or send an NHIS
// claim from the claim form (Save Details, Send to Dispensary, and the
// correction saves that use the same action). Serving directly is already
// guarded separately, and CCC/CC is still required again before export.
//
// Manual entry stays available: the code box is a normal typeable field, so
// staff can type the code when NHIA generation is unavailable. The only
// exception is a user whose field is locked (manual claim control for a role
// that may not type the code, "a controlled correction"): they cannot supply
// the code, so they are not blocked by this rule.
export const NHIS_CCC_REQUIRED_TO_SAVE_INTENTS = Object.freeze(['save_details', 'dispatch'])

export const NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE =
  'CCC/CC code is required before saving this NHIS claim. Generate it with NHIA, or type the 5-digit code if generation is unavailable.'

export const getNhisCccSaveIssue = (claim = {}, { intent = '', fieldLocked = false } = {}) => {
  if (!NHIS_CCC_REQUIRED_TO_SAVE_INTENTS.includes(intent)) return ''
  if (fieldLocked) return ''

  const digits = String(claim?.cccNo ?? claim?.ccc_no ?? claim?.ccCode ?? claim?.cc_code ?? '').replace(/\D/g, '')
  if (!digits) return NHIS_CCC_REQUIRED_TO_SAVE_MESSAGE

  return getNhisCccTransitionIssue(claim)
}
