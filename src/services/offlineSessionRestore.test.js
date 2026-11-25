import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({ supabase: null }))

const load = async () => {
  vi.resetModules()
  return await import('./branchServerApi')
}

const save = (key, session) => window.localStorage.setItem(key, JSON.stringify(session))
const session = (extra = {}) => ({
  token: 'invented-session', role: 'cashier', offline: true,
  expiresAt: Math.floor(Date.now() / 1000) + 3600, user: { id: 'test-cashier' }, profile: { id: 'test-cashier' },
  ...extra,
})

describe('restoring an offline sign-in after the page is refreshed', () => {
  beforeEach(() => window.localStorage.clear())

  it('works although the starting page has written its default role over the saved one', async () => {
    const api = await load()
    save(api.BRANCH_USER_SESSION_STORAGE_KEY, session())
    // What the app stores while it does not yet know who is signed in.
    window.localStorage.setItem('healthflow.active-role.current', 'assistant')

    expect(api.getSavedOfflineStaffSession()).toMatchObject({ role: 'cashier', token: 'invented-session' })
  })

  it('does not restore a sign-in that expired, was made online, or is not complete', async () => {
    const api = await load()
    for (const saved of [
      session({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
      session({ offline: false }),
      session({ token: '' }),
    ]) {
      save(api.BRANCH_USER_SESSION_STORAGE_KEY, saved)
      expect(api.getSavedOfflineStaffSession()).toBeNull()
    }
    window.localStorage.setItem(api.BRANCH_USER_SESSION_STORAGE_KEY, 'not json')
    expect(api.getSavedOfflineStaffSession()).toBeNull()
  })
})
