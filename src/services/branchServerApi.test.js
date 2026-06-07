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

  it('does not create a default branch token when missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    const { BRANCH_TOKEN_STORAGE_KEY, getSavedBranchToken } = await importBranchServerApi()

    expect(getSavedBranchToken()).toBe('')
    expect(window.localStorage.getItem(BRANCH_TOKEN_STORAGE_KEY)).toBeNull()
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

  it('maps NHIA member lookup aliases to the branch server payload', async () => {
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
})
