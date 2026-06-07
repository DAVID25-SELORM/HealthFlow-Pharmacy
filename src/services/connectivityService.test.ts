import { beforeEach, describe, expect, it, vi } from 'vitest'

const BRANCH_TOKEN_STORAGE_KEY = 'healthflow_branch_token'

const setNavigatorOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  })
}

const importConnectivityService = async () => {
  vi.resetModules()
  return await import('./connectivityService')
}

describe('connectivityService', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
    setNavigatorOnline(true)
  })

  it('does not probe the local branch server during online cloud refreshes', async () => {
    window.localStorage.setItem(BRANCH_TOKEN_STORAGE_KEY, 'branch-token')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { CONNECTIVITY_MODES, getConnectivityState, refreshConnectivityState } =
      await importConnectivityService()

    await refreshConnectivityState()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getConnectivityState().mode).toBe(CONNECTIVITY_MODES.ONLINE_CLOUD)
  })

  it('probes the local branch server when explicitly requested', async () => {
    window.localStorage.setItem(BRANCH_TOKEN_STORAGE_KEY, 'branch-token')
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { CONNECTIVITY_MODES, getConnectivityState, refreshConnectivityState } =
      await importConnectivityService()

    await refreshConnectivityState({ probeLocal: true })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4780/health',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-branch-token': 'branch-token',
        }),
      })
    )
    expect(getConnectivityState().mode).toBe(CONNECTIVITY_MODES.ONLINE_LOCAL_SYNC)
  })
})
