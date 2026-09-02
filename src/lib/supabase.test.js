import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const NOW = new Date('2026-04-23T12:00:00.000Z')

describe('invokeSupabaseFunction', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project-ref.supabase.co')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('uses the HealthFlow gateway URL when it is configured', async () => {
    vi.stubEnv('VITE_HEALTHFLOW_CLOUD_URL', 'https://api.healthflowcloud.com/')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '')

    const createClient = vi.fn(() => ({
      auth: {
        getSession: vi.fn(),
        getUser: vi.fn(),
        refreshSession: vi.fn(),
      },
      functions: {
        invoke: vi.fn(),
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const {
      getConfiguredCloudUrl,
      getConfiguredSupabaseStorageUrl,
      supabaseAuthStorageKey,
    } = await import('./supabase')

    expect(getConfiguredCloudUrl()).toBe('https://api.healthflowcloud.com')
    expect(getConfiguredSupabaseStorageUrl()).toBe('https://project-ref.storage.supabase.co')
    expect(createClient).toHaveBeenCalledWith(
      'https://api.healthflowcloud.com',
      'anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({
          storageKey: 'sb-project-ref-auth-token',
        }),
      })
    )
    expect(supabaseAuthStorageKey).toBe('sb-project-ref-auth-token')

    const authLock = createClient.mock.calls[0][2].auth.lock
    const operation = vi.fn(async () => 'completed')
    const request = vi.fn(async (_name, options, callback) => callback())
    vi.stubGlobal('navigator', { locks: { request } })

    await expect(authLock('lock:sb-project-ref-auth-token', 0, operation)).resolves.toBe('completed')
    expect(request).toHaveBeenCalledWith(
      'lock:sb-project-ref-auth-token',
      { mode: 'exclusive' },
      operation
    )
  })

  it('reuses the latest stored session when a refresh races with another tab', async () => {
    const expiringSession = {
      access_token: 'stale-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 30,
    }
    const refreshedByAnotherTabSession = {
      access_token: 'fresh-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    }

    const getSession = vi
      .fn()
      .mockResolvedValueOnce({
        data: { session: expiringSession },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { session: refreshedByAnotherTabSession },
        error: null,
      })
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: {
        status: 400,
        name: 'AuthApiError',
        message: 'refresh already handled by another tab',
      },
    })
    const invoke = vi.fn().mockResolvedValue({
      data: { ok: true },
      error: null,
    })
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser: vi.fn(),
        refreshSession,
      },
      functions: {
        invoke,
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { invokeSupabaseFunction } = await import('./supabase')

    const result = await invokeSupabaseFunction('staff-admin', {
      body: { action: 'ping' },
    })

    expect(result).toEqual({
      data: { ok: true },
      error: null,
    })
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(
      'staff-admin',
      expect.objectContaining({
        body: { action: 'ping' },
        headers: expect.objectContaining({
          Authorization: 'Bearer fresh-token',
        }),
      })
    )
  })

  it('maps cloud function fetch failures to actionable errors', async () => {
    const activeSession = {
      access_token: 'active-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    }

    const getSession = vi.fn().mockResolvedValue({
      data: { session: activeSession },
      error: null,
    })
    const invoke = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser: vi.fn(),
        refreshSession: vi.fn(),
      },
      functions: {
        invoke,
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { invokeSupabaseFunction } = await import('./supabase')

    const result = await invokeSupabaseFunction('tier-access', {
      body: { action: 'submit_nhia_claims_direct' },
    })

    expect(result.error?.message).toContain('Unable to reach the HealthFlow Cloud service "tier-access"')
  })

  it('reuses the cached AuthContext session for repeated function calls', async () => {
    const activeSession = {
      access_token: 'cached-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
      user: { id: 'user-1', email: 'admin@example.com' },
    }

    const getSession = vi.fn().mockResolvedValue({
      data: { session: activeSession },
      error: null,
    })
    const invoke = vi.fn().mockResolvedValue({
      data: { ok: true },
      error: null,
    })
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser: vi.fn(),
        refreshSession: vi.fn(),
      },
      functions: {
        invoke,
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { invokeSupabaseFunction, setCachedSupabaseSession } = await import('./supabase')
    setCachedSupabaseSession(activeSession)

    await invokeSupabaseFunction('tier-access', { body: { action: 'first' } })
    await invokeSupabaseFunction('tier-access', { body: { action: 'second' } })

    expect(getSession).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'tier-access',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer cached-token' }),
      })
    )
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'tier-access',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer cached-token' }),
      })
    )
  })

  it('surfaces Supabase function 400 response details', async () => {
    const activeSession = {
      access_token: 'active-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    }

    const getSession = vi.fn().mockResolvedValue({
      data: { session: activeSession },
      error: null,
    })
    const responseBody = {
      error: 'NHIA configuration is incomplete for claimit_assisted: missing claimsOfficerName.',
      missingFields: ['claimsOfficerName'],
      received: { action: 'save_nhia_api_settings' },
    }
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: {
        name: 'FunctionsHttpError',
        context: new Response(JSON.stringify(responseBody), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      },
    })
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser: vi.fn(),
        refreshSession: vi.fn(),
      },
      functions: {
        invoke,
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { invokeSupabaseFunction } = await import('./supabase')

    const result = await invokeSupabaseFunction('tier-access', {
      body: { action: 'save_nhia_api_settings' },
    })

    expect(result.error?.message).toBe(responseBody.error)
    expect(result.error?.status).toBe(400)
    expect(result.error?.missingFields).toEqual(['claimsOfficerName'])
    expect(result.error?.details).toEqual(responseBody.received)
  })

  it('allows approved public tenant signup actions without reading a user session', async () => {
    const getSession = vi.fn()
    const invoke = vi.fn().mockResolvedValue({
      data: { ok: true },
      error: null,
    })
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser: vi.fn(),
        refreshSession: vi.fn(),
      },
      functions: {
        invoke,
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { invokeSupabaseFunctionPublic } = await import('./supabase')

    const result = await invokeSupabaseFunctionPublic('tenant-signup', {
      body: { action: 'register_signup' },
    })

    expect(result).toEqual({ data: { ok: true }, error: null })
    expect(getSession).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith(
      'tenant-signup',
      expect.objectContaining({
        body: { action: 'register_signup' },
        headers: expect.objectContaining({
          Authorization: 'Bearer anon-key',
        }),
      })
    )
  })

  it('blocks unapproved public function actions before invoking the network', async () => {
    const invoke = vi.fn()
    const createClient = vi.fn(() => ({
      auth: {
        getSession: vi.fn(),
        getUser: vi.fn(),
        refreshSession: vi.fn(),
      },
      functions: {
        invoke,
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { invokeSupabaseFunctionPublic } = await import('./supabase')

    await expect(
      invokeSupabaseFunctionPublic('tenant-signup', {
        body: { action: 'create_tenant' },
      })
    ).rejects.toThrow('does not allow anonymous access')

    expect(invoke).not.toHaveBeenCalled()
  })

  it('refreshes before reading the current user when the stored session is expired', async () => {
    const expiredSession = {
      access_token: 'expired-token',
      expires_at: Math.floor(NOW.getTime() / 1000) - 60,
    }
    const refreshedSession = {
      access_token: 'fresh-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    }
    const user = {
      id: 'user-1',
      email: 'admin@example.com',
    }

    const getSession = vi.fn().mockResolvedValue({
      data: { session: expiredSession },
      error: null,
    })
    const getUser = vi.fn().mockResolvedValue({
      data: { user },
      error: null,
    })
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: refreshedSession },
      error: null,
    })
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser,
        refreshSession,
      },
      functions: {
        invoke: vi.fn(),
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { getCurrentSupabaseUser } = await import('./supabase')

    await expect(getCurrentSupabaseUser()).resolves.toEqual(user)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledTimes(1)
  })

  it('retries reading the current user after refreshing an invalid JWT', async () => {
    const staleSession = {
      access_token: 'stale-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    }
    const refreshedSession = {
      access_token: 'fresh-token',
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    }
    const user = {
      id: 'user-1',
      email: 'admin@example.com',
    }

    const getSession = vi.fn().mockResolvedValue({
      data: { session: staleSession },
      error: null,
    })
    const getUser = vi
      .fn()
      .mockResolvedValueOnce({
        data: { user: null },
        error: {
          status: 403,
          name: 'AuthApiError',
          message: 'invalid JWT: token has invalid claims: token is expired',
        },
      })
      .mockResolvedValueOnce({
        data: { user },
        error: null,
      })
    const refreshSession = vi.fn().mockResolvedValue({
      data: { session: refreshedSession },
      error: null,
    })
    const createClient = vi.fn(() => ({
      auth: {
        getSession,
        getUser,
        refreshSession,
      },
      functions: {
        invoke: vi.fn(),
      },
    }))

    vi.doMock('@supabase/supabase-js', () => ({
      createClient,
    }))

    const { getCurrentSupabaseUser } = await import('./supabase')

    await expect(getCurrentSupabaseUser()).resolves.toEqual(user)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledTimes(2)
  })
})
