import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/browserEncryption', () => ({
  encryptJson: vi.fn(async (value) => ({ __encrypted: true, version: 'hf-aes-gcm-v1', value })),
  decryptJson: vi.fn(async (value) => value?.value || null),
  isEncryptedEnvelope: vi.fn((value) => value?.__encrypted === true),
}))

import { clearUnsavedDraft, loadUnsavedDraft, saveUnsavedDraft } from './unsavedDraftRecovery'

const identity = { userId: 'user-1', organizationId: 'org-1', scope: 'pos-cart' }

describe('unsaved draft recovery', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('stores only an encrypted envelope and restores it for the same user and organisation', async () => {
    await expect(saveUnsavedDraft({ ...identity, payload: { cart: [{ id: 'drug-1' }] }, now: 100 })).resolves.toBe(true)
    const stored = JSON.parse(window.localStorage.getItem('healthflow.unsaved-draft.v1.user-1.org-1.pos-cart'))
    expect(stored.__encrypted).toBe(true)
    await expect(loadUnsavedDraft({ ...identity, now: 101 })).resolves.toEqual({ cart: [{ id: 'drug-1' }] })
  })

  it('does not reveal a draft to another user and removes expired drafts', async () => {
    await saveUnsavedDraft({ ...identity, payload: { cart: [{ id: 'drug-1' }] }, now: 100 })
    await expect(loadUnsavedDraft({ ...identity, userId: 'user-2', now: 101 })).resolves.toBeNull()
    await expect(loadUnsavedDraft({ ...identity, now: 9 * 60 * 60 * 1000 })).resolves.toBeNull()
    expect(window.localStorage.getItem('healthflow.unsaved-draft.v1.user-1.org-1.pos-cart')).toBeNull()
  })

  it('can explicitly discard a local draft', async () => {
    await saveUnsavedDraft({ ...identity, payload: { cart: [{ id: 'drug-1' }] }, now: 100 })
    clearUnsavedDraft(identity)
    await expect(loadUnsavedDraft({ ...identity, now: 101 })).resolves.toBeNull()
  })
})
