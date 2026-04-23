import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'

const mocks = vi.hoisted(() => {
  let authStateChangeCallback = null

  const queryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  }

  queryBuilder.select.mockImplementation(() => queryBuilder)
  queryBuilder.eq.mockImplementation(() => queryBuilder)

  const subscription = {
    unsubscribe: vi.fn(),
  }

  const auth = {
    getSession: vi.fn(),
    getUser: vi.fn(),
    onAuthStateChange: vi.fn((callback) => {
      authStateChangeCallback = callback
      return { data: { subscription } }
    }),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    resetPasswordForEmail: vi.fn(),
  }

  const supabase = {
    auth,
    from: vi.fn(() => queryBuilder),
  }

  return {
    auth,
    clearSupabaseStoredSession: vi.fn(),
    getAuthStateChangeCallback: () => authStateChangeCallback,
    queryBuilder,
    subscription,
    supabase,
  }
})

vi.mock('../lib/supabase', () => ({
  clearSupabaseStoredSession: mocks.clearSupabaseStoredSession,
  isSupabaseConfigured: () => true,
  supabase: mocks.supabase,
}))

const Probe = () => {
  const { displayName, isAuthenticated, loading } = useAuth()

  return (
    <div data-testid="auth-state">
      {loading ? 'loading' : isAuthenticated ? `signed-in:${displayName}` : 'signed-out'}
    </div>
  )
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryBuilder.select.mockImplementation(() => mocks.queryBuilder)
    mocks.queryBuilder.eq.mockImplementation(() => mocks.queryBuilder)
  })

  it('accepts a fresh sign-in after clearing an invalid stored session', async () => {
    const expiredSession = {
      access_token: 'expired-token',
      user: { id: 'expired-user', email: 'expired@example.com' },
    }
    const validUser = {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { full_name: 'Admin User' },
    }
    const validSession = {
      access_token: 'fresh-token',
      user: validUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: expiredSession },
    })
    mocks.auth.getUser
      .mockResolvedValueOnce({
        data: { user: null },
        error: {
          status: 403,
          name: 'AuthApiError',
          message: 'invalid JWT: token is expired',
        },
      })
      .mockResolvedValueOnce({
        data: { user: validUser },
        error: null,
      })
    mocks.queryBuilder.maybeSingle.mockResolvedValue({
      data: {
        id: validUser.id,
        email: validUser.email,
        full_name: 'Admin User',
        role: 'admin',
        is_active: true,
      },
      error: null,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-out')
    })
    expect(mocks.clearSupabaseStoredSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      mocks.getAuthStateChangeCallback()?.('SIGNED_IN', validSession)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })
    expect(mocks.auth.getUser).toHaveBeenCalledTimes(2)
  })

  it('keeps the user signed in when a non-signout auth event temporarily has no session', async () => {
    const validUser = {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { full_name: 'Admin User' },
    }
    const validSession = {
      access_token: 'fresh-token',
      user: validUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: validSession },
      error: null,
    })
    mocks.auth.getUser.mockResolvedValue({
      data: { user: validUser },
      error: null,
    })
    mocks.queryBuilder.maybeSingle.mockResolvedValue({
      data: {
        id: validUser.id,
        email: validUser.email,
        full_name: 'Admin User',
        role: 'admin',
        is_active: true,
      },
      error: null,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })

    await act(async () => {
      mocks.getAuthStateChangeCallback()?.('TOKEN_REFRESHED', null)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })

  it('keeps the current session when a refresh race reports a temporary auth failure', async () => {
    const validUser = {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { full_name: 'Admin User' },
    }
    const validSession = {
      access_token: 'fresh-token',
      user: validUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: validSession },
      error: null,
    })
    mocks.auth.getUser
      .mockResolvedValueOnce({
        data: { user: validUser },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user: null },
        error: {
          status: 401,
          name: 'AuthSessionMissingError',
          message: 'session missing while the browser refreshes auth state',
        },
      })
    mocks.queryBuilder.maybeSingle.mockResolvedValue({
      data: {
        id: validUser.id,
        email: validUser.email,
        full_name: 'Admin User',
        role: 'admin',
        is_active: true,
      },
      error: null,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })

    await act(async () => {
      mocks.getAuthStateChangeCallback()?.('TOKEN_REFRESHED', validSession)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })
})
