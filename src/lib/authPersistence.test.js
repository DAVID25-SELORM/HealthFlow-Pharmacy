import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const storageKey = 'healthflow-test-session-persistence'
const clients = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.auth.stopAutoRefresh()))
  localStorage.removeItem(storageKey)
  vi.unstubAllGlobals()
})

describe('installed Supabase SDK browser persistence', () => {
  it('persists login and restores it into fresh clients representing page/tab/browser restarts', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const request = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer',
      expires_in: 3600, user: {id:'test-user',aud:'authenticated'},
    }), {status:200,headers:{'Content-Type':'application/json'}}))
    const openClient = () => {
      const client = createClient('https://persistence-test.supabase.co', 'test-key', {
        auth: {persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey,lock:async (_name,_timeout,fn)=>fn()},
        global:{fetch:request},
      })
      clients.push(client)
      return client
    }
    const first = openClient()
    const login = await first.auth.signInWithPassword({email:'test@example.com',password:'test-password'})
    expect(login.error).toBeNull()
    expect(localStorage.getItem(storageKey)).not.toBeNull()
    await first.auth.stopAutoRefresh()
    for (let restart = 0; restart < 3; restart += 1) {
      const restored = openClient()
      const result = await restored.auth.getSession()
      expect(result.error).toBeNull()
      expect(result.data.session?.user.id).toBe('test-user')
      await restored.auth.stopAutoRefresh()
    }
    expect(request).toHaveBeenCalledTimes(1)
  })
})
