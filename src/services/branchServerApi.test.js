import { beforeEach, describe, expect, it, vi } from 'vitest'

const importBranchServerApi = async () => {
  vi.resetModules()
  return await import('./branchServerApi')
}

describe('branchServerApi', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('saves the default branch token in localStorage when missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    const { BRANCH_TOKEN_STORAGE_KEY, DEFAULT_BRANCH_TOKEN, getSavedBranchToken } =
      await importBranchServerApi()

    expect(getSavedBranchToken()).toBe(DEFAULT_BRANCH_TOKEN)
    expect(window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY)).toBe(DEFAULT_BRANCH_TOKEN)
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
      DEFAULT_BRANCH_TOKEN,
      downloadNhiaBatchExport,
      pullBranchInventory,
    } = await importBranchServerApi()

    await pullBranchInventory()
    await downloadNhiaBatchExport('batch-1', 'json')

    const localApiCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('http://localhost:4780/api/')
    )

    expect(localApiCalls.length).toBeGreaterThanOrEqual(2)
    expect(window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY)).toBe(DEFAULT_BRANCH_TOKEN)
    localApiCalls.forEach(([, options]) => {
      expect(options.headers['x-branch-token']).toBe(DEFAULT_BRANCH_TOKEN)
    })
  })
})
