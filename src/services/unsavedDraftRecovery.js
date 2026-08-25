import { decryptJson, encryptJson, isEncryptedEnvelope } from '../utils/browserEncryption'

// Drafts are deliberately local-only. They are never sent to the API and are
// keyed to the authenticated user as well as the current organisation.
const STORAGE_PREFIX = 'healthflow.unsaved-draft.v1'
export const UNSAVED_DRAFT_TTL_MS = 8 * 60 * 60 * 1000

const isBrowser = () => typeof window !== 'undefined' && Boolean(window.localStorage)
const hasWebCrypto = () => Boolean(window?.crypto?.subtle && window?.crypto?.getRandomValues)
const draftKey = ({ userId, organizationId, scope }) =>
  `${STORAGE_PREFIX}.${encodeURIComponent(userId)}.${encodeURIComponent(organizationId)}.${scope}`

const validIdentity = ({ userId, organizationId, scope }) =>
  Boolean(userId && organizationId && scope)

export const saveUnsavedDraft = async ({ userId, organizationId, scope, payload, now = Date.now() }) => {
  if (!isBrowser() || !hasWebCrypto() || !validIdentity({ userId, organizationId, scope })) return false

  try {
    const protectedDraft = await encryptJson({
      userId,
      organizationId,
      scope,
      savedAt: now,
      expiresAt: now + UNSAVED_DRAFT_TTL_MS,
      payload,
    })
    // Do not fall back to plaintext for patient or claim/cart data.
    if (!isEncryptedEnvelope(protectedDraft)) return false
    window.localStorage.setItem(draftKey({ userId, organizationId, scope }), JSON.stringify(protectedDraft))
    return true
  } catch {
    return false
  }
}

export const clearUnsavedDraft = ({ userId, organizationId, scope }) => {
  if (!isBrowser() || !validIdentity({ userId, organizationId, scope })) return
  window.localStorage.removeItem(draftKey({ userId, organizationId, scope }))
}

export const loadUnsavedDraft = async ({ userId, organizationId, scope, now = Date.now() }) => {
  if (!isBrowser() || !validIdentity({ userId, organizationId, scope })) return null
  const key = draftKey({ userId, organizationId, scope })
  try {
    const stored = window.localStorage.getItem(key)
    if (!stored) return null
    const decoded = await decryptJson(JSON.parse(stored))
    const valid = decoded &&
      decoded.userId === userId &&
      decoded.organizationId === organizationId &&
      decoded.scope === scope &&
      Number(decoded.expiresAt) > now
    if (!valid) {
      window.localStorage.removeItem(key)
      return null
    }
    return decoded.payload || null
  } catch {
    window.localStorage.removeItem(key)
    return null
  }
}
