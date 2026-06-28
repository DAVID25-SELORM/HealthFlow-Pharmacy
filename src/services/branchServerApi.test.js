import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
  },
}))

const importBranchServerApi = async () => {
  vi.resetModules()
  return await import('./branchServerApi')
}

describe('branchServerApi', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete window.__HEALTHFLOW_BRANCH_SERVER__
    vi.restoreAllMocks()
    mocks.getSession.mockReset()
  })

  it('does not create a default branch token when missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    const { BRANCH_TOKEN_STORAGE_KEY, getSavedBranchToken } = await importBranchServerApi()

    expect(getSavedBranchToken()).toBe('')
    expect(window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('enables the bundled same-origin branch app without exposing a JavaScript token', async () => {
    window.__HEALTHFLOW_BRANCH_SERVER__ = {
      enabled: true,
      url: window.location.origin,
      token: '',
    }

    const { getBranchServerConfig, isBranchServerEnabled } = await importBranchServerApi()

    expect(getBranchServerConfig()).toMatchObject({
      enabled: true,
      token: '',
    })
    expect(isBranchServerEnabled()).toBe(true)
  })

  it('sends the localStorage branch token on local branch API requests', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }

      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const {
      BRANCH_TOKEN_STORAGE_KEY,
      downloadNhiaBatchExport,
      pullBranchInventory,
      pullBranchReferenceData,
      saveBranchToken,
    } = await importBranchServerApi()

    const branchToken = 'facility-branch-token'
    saveBranchToken(branchToken)

    await pullBranchInventory()
    await pullBranchReferenceData()
    await downloadNhiaBatchExport('batch-1', 'json')

    const localApiCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('http://localhost:4780/api/')
    )
    const syncPostCalls = fetchMock.mock.calls.filter(
      ([url, options]) =>
        [
          'http://localhost:4780/api/sync/pull-inventory',
          'http://localhost:4780/api/sync/pull-reference-data',
        ].includes(String(url)) && options.method === 'POST'
    )

    expect(localApiCalls.length).toBeGreaterThanOrEqual(2)
    expect(syncPostCalls).toHaveLength(2)
    expect(window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY)).toBe(branchToken)
    syncPostCalls.forEach(([, options]) => {
      expect(options.headers['x-branch-token']).toBe(branchToken)
    })
  })

  it('sends the localStorage branch token on health checks', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { getBranchServerHealth, saveBranchToken } = await importBranchServerApi()
    const branchToken = 'facility-branch-token'
    saveBranchToken(branchToken)

    await getBranchServerHealth()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4780/health',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-branch-token': branchToken,
        }),
      })
    )
  })

  it('waits for a real terminal updater state across service restart responses', async () => {
    const states = [
      { state: 'backing_up', currentVersion: '1.2.6' },
      { state: 'verifying', currentVersion: '1.2.6' },
      { state: 'installed', currentVersion: '1.2.7' },
    ]
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: states.shift() }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const {
      saveBranchToken,
      waitForBranchUpdateCompletion,
    } = await importBranchServerApi()
    saveBranchToken('facility-branch-token')
    const observed = []

    const status = await waitForBranchUpdateCompletion({
      expectedVersion: '1.2.7',
      pollIntervalMs: 1,
      timeoutMs: 1000,
      onStatus: (nextStatus) => observed.push(nextStatus.state),
    })

    expect(status.state).toBe('installed')
    expect(observed).toEqual(['backing_up', 'verifying', 'installed'])
  })

  it('maps NHIA member lookup aliases to the branch server payload', async () => {
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'supabase-user-token',
          user: { id: 'staff-1' },
        },
      },
      error: null,
    })
    window.localStorage.setItem('healthflow.active-role.current', 'claims_officer')
    window.localStorage.setItem('healthflow_branch_user_session', JSON.stringify({
      token: 'signed-branch-user-session',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      role: 'claims_officer',
      userId: 'staff-1',
    }))
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { status: 'ACTIVE' } }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { lookupNhiaMember, saveBranchToken } = await importBranchServerApi()
    saveBranchToken('facility-branch-token')

    await lookupNhiaMember({ nhisNumber: 'gha1234567890' })

    const [, options] = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/nhia/member-lookup')
    )
    expect(JSON.parse(options.body)).toEqual({
      memberNumber: 'GHA-123456789-0',
      cardType: 'GHANACARD',
    })
  })

  it('does not call member lookup with an empty memberNumber', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { lookupNhiaMember } = await importBranchServerApi()

    await expect(lookupNhiaMember({ insuranceId: '  ' })).rejects.toThrow('memberNumber is required.')
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith('/api/nhia/member-lookup')
    )).toBe(false)
  })

  it('uses a server-issued staff session for local NHIS writes', async () => {
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'supabase-user-token',
          user: { id: 'staff-1' },
        },
      },
      error: null,
    })
    window.localStorage.setItem('healthflow.active-role.current', 'claims_officer')
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/api/auth/user-session')) {
        return new Response(JSON.stringify({
          data: {
            token: 'signed-branch-user-session',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            role: 'claims_officer',
            userId: 'staff-1',
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: { id: 'claim-1' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { saveBranchToken, updateBranchRecord } = await importBranchServerApi()
    saveBranchToken('facility-branch-token')

    await updateBranchRecord('nhis/claims', 'claim-1', { notes: 'reviewed' })

    const sessionCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/auth/user-session')
    )
    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/nhis/claims/claim-1')
    )
    expect(sessionCall[1].headers.Authorization).toBe('Bearer supabase-user-token')
    expect(updateCall[1].headers['x-branch-user-session']).toBe('signed-branch-user-session')
  })
})
