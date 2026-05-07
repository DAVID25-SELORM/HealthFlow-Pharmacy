import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const NOW = new Date('2026-04-23T12:00:00.000Z')

describe('invokeSupabaseFunction', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project-ref.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.clearAllMocks()
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
