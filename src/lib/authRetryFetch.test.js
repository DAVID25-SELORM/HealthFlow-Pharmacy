import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('auth transport failure isolation', () => {
  let clientOptions, refreshSession, fetchMock, expired
  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL','https://project-ref.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','test-key')
    refreshSession = vi.fn()
    vi.doMock('@supabase/supabase-js', () => ({createClient: (_url,_key,options) => {
      clientOptions = options
      return {auth:{refreshSession}}
    }}))
    fetchMock = vi.fn()
    vi.stubGlobal('fetch',fetchMock)
    const { subscribeSupabaseAuthExpired } = await import('./supabase')
    expired = vi.fn()
    const unsubscribe = subscribeSupabaseAuthExpired(expired)
    cleanups.push(unsubscribe)
  })
  const cleanups = []
  afterEach(() => { cleanups.splice(0).forEach(fn=>fn()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })
  it.each([400,403,500])('does not expire the session for application API %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('{}',{status}))
    expect((await clientOptions.global.fetch('https://project-ref.supabase.co/functions/v1/tier-access')).status).toBe(status)
    expect(refreshSession).not.toHaveBeenCalled()
    expect(expired).not.toHaveBeenCalled()
  })
  it.each([
    {status:503,name:'AuthApiError',message:'server failure'},
    {status:429,message:'rate limit'},
    new TypeError('Failed to fetch'),
  ])('does not destroy a session after a 401 followed by transient refresh failure: %s', async (error) => {
    fetchMock.mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValue(new Response('{}'))
    refreshSession.mockResolvedValue({data:{session:null},error})
    await expect(clientOptions.global.fetch('https://project-ref.supabase.co/rest/v1/users')).rejects.toBe(error)
    expect(expired).not.toHaveBeenCalled()
    expect((await clientOptions.global.fetch('https://project-ref.supabase.co/rest/v1/users')).status).toBe(200)
    expect(refreshSession).toHaveBeenCalledTimes(1)
  })
  it('expires a genuinely revoked refresh session', async () => {
    fetchMock.mockResolvedValue(new Response('{}',{status:401}))
    refreshSession.mockResolvedValue({data:{session:null},error:{status:400,code:'refresh_token_not_found'}})
    expect((await clientOptions.global.fetch('https://project-ref.supabase.co/rest/v1/users')).status).toBe(401)
    expect(expired).toHaveBeenCalledTimes(1)
  })
  it('surfaces network failure without dispatching logout', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(clientOptions.global.fetch('https://project-ref.supabase.co/rest/v1/users')).rejects.toThrow('Failed to fetch')
    expect(expired).not.toHaveBeenCalled()
  })
  it('preserves recovery for customer e-pharmacy direct SDK calls', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', {status:401})).mockResolvedValue(new Response('{}'))
    refreshSession.mockResolvedValue({data:{session:{access_token:'fixture-new'}},error:null})
    expect((await clientOptions.global.fetch('https://project-ref.supabase.co/functions/v1/customer-epharmacy')).status).toBe(200)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(expired).not.toHaveBeenCalled()
  })

})
