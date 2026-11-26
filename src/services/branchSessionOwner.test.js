import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ cachedUser: null, getSession: vi.fn() }))
vi.mock('../lib/supabase', () => ({
  getCachedSupabaseUser: () => mocks.cachedUser,
  supabase: { auth: { getSession: mocks.getSession } },
}))

const load = async () => {
  vi.resetModules()
  return await import('./branchServerApi')
}

// What one pharmacy's administrator left in a browser without pressing Sign out.
const leftBehind = {
  token: 'session-of-user-a', userId: 'user-a', role: 'admin', offline: false,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
}

const sessionHeadersSent = async (api) => {
  const requests = []
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    requests.push({ url: String(url), headers: options.headers })
    if (String(url).endsWith('/api/auth/user-session')) {
      return new Response(JSON.stringify({ data: { ...leftBehind, token: 'session-of-user-b', userId: 'user-b' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }))
  await api.listBranchRecords('patients')
  return requests.filter((request) => request.url.includes('/api/patients')).map((request) => request.headers['x-branch-user-session'])
}

describe('a saved offline-server session', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.__HEALTHFLOW_BRANCH_SERVER__ = { enabled: true, url: window.location.origin, token: '' }
    window.localStorage.setItem('healthflow.workstation.id', 'invented-computer')
    window.localStorage.setItem('healthflow.workstation.secret', 'invented-computer-secret')
    window.localStorage.setItem('healthflow.active-role.current', 'admin')
    window.localStorage.setItem('healthflow_branch_user_session', JSON.stringify(leftBehind))
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'cloud-token', user: { id: 'user-b' } } }, error: null })
  })

  it('is not used for someone else who signs in, even with the same role', async () => {
    mocks.cachedUser = { id: 'user-b' }
    expect(await sessionHeadersSent(await load())).toEqual(['session-of-user-b'])
  })

  it('is still used by its own user, and when the cloud cannot say who is signed in', async () => {
    for (const cachedUser of [{ id: 'user-a' }, null]) {
      window.localStorage.setItem('healthflow_branch_user_session', JSON.stringify(leftBehind))
      mocks.cachedUser = cachedUser
      expect(await sessionHeadersSent(await load())).toEqual(['session-of-user-a'])
    }
  })

  it('is not used at all by a locked offline server', async () => {
    window.__HEALTHFLOW_BRANCH_SERVER__ = { enabled: true, url: window.location.origin, token: '', dataLocked: true }
    const api = await load()
    expect(api.isBranchServerEnabled()).toBe(false)
  })
})
