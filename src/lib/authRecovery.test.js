import { afterEach, beforeEach, expect, it, vi } from 'vitest'
let api, refresh, fetchMock, expired, cleanup
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'fixture')
  refresh = vi.fn()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.doMock('@supabase/supabase-js', () => ({ createClient: (_url, _key, options) => ({
    auth: { refreshSession: refresh },
    functions: { invoke: async () => {
      const response = await options.global.fetch('https://project.supabase.co/functions/v1/tier-access')
      return response.ok ? { data: 'ok', error: null } : { data: null, error: { name: 'FunctionsHttpError', context: response } }
    } },
  }) }))
  api = await import('./supabase')
  api.setCachedSupabaseSession({ access_token: 'fixture-old', expires_at: Date.now() / 1000 + 3600 })
  expired = vi.fn()
  cleanup = api.subscribeSupabaseAuthExpired(expired)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })
it('401 recovery succeeds with exactly one refresh and one retry', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValue(new Response('{}'))
  refresh.mockResolvedValue({ data: { session: { access_token: 'fixture-new', expires_at: Date.now() / 1000 + 3600 } }, error: null })
  await expect(api.invokeSupabaseFunction('tier-access')).resolves.toMatchObject({ data: 'ok' })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(expired).not.toHaveBeenCalled()
})
it.each([{ status: 503, message: 'Service unavailable' }, new TypeError('Failed to fetch'), { status: 429, message: 'Rate limited' }])('preserves session on transient refresh failure', async (error) => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
  refresh.mockResolvedValue({ data: { session: null }, error })
  await expect(api.invokeSupabaseFunction('tier-access')).rejects.toBe(error)
  expect(api.getCachedSupabaseSession().access_token).toBe('fixture-old')
  expect(expired).not.toHaveBeenCalled()
  expect(refresh).toHaveBeenCalledTimes(1)
})
it.each(['refresh_token_not_found', 'refresh_token_already_used'])('shares concurrent refresh and clears once for %s', async (code) => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
  let finish
  refresh.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const first = api.invokeSupabaseFunction('tier-access')
  const second = api.invokeSupabaseFunction('tier-access')
  const results = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  finish({ data: { session: null }, error: { status: 400, code } })
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
  expect(expired).toHaveBeenCalledTimes(1)
  expect(api.getCachedSupabaseSession()).toBeNull()
})
it('does not refresh again when the retried function is still unauthorized', async () => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
  refresh.mockResolvedValue({ data: { session: { access_token: 'fixture-new', expires_at: Date.now() / 1000 + 3600 } }, error: null })
  await expect(api.invokeSupabaseFunction('tier-access')).rejects.toThrow('session has expired')
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('renews two concurrent rejected requests with one shared successful refresh', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValue(new Response('{}'))
  let finish
  refresh.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const both = Promise.all([api.invokeSupabaseFunction('tier-access'), api.invokeSupabaseFunction('tier-access')])
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  finish({ data: { session: { access_token: 'fixture-new', expires_at: Date.now() / 1000 + 3600 } }, error: null })
  expect((await both).every(result => result.data === 'ok')).toBe(true)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(expired).not.toHaveBeenCalled()
})
it('preserves transient errors in raw function response recovery', async () => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
  const error = new TypeError('Failed to fetch')
  refresh.mockResolvedValue({ data: { session: null }, error })
  await expect(api.invokeSupabaseFunctionResponse('tier-access')).rejects.toBe(error)
  expect(expired).not.toHaveBeenCalled()
  expect(api.getCachedSupabaseSession()).not.toBeNull()
})
