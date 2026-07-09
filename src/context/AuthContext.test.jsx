import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    refreshSession: vi.fn(),
    onAuthStateChange: vi.fn((callback) => {
      authStateChangeCallback = callback
      return { data: { subscription } }
    }),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
  }

  const supabase = {
    auth,
    from: vi.fn(() => queryBuilder),
  }

  return {
    auth,
    clearSupabaseStoredSession: vi.fn(),
    getAuthStateChangeCallback: () => authStateChangeCallback,
    markSupabaseAuthActive: vi.fn(),
    queryBuilder,
    refreshSupabaseSessionOnce: vi.fn(() =>
      auth.refreshSession().then(({ data, error }) => ({
        session: data?.session || null,
        error: error || null,
      }))
    ),
    subscription,
    supabase,
  }
})

vi.mock('../lib/supabase', () => ({
  clearSupabaseStoredSession: mocks.clearSupabaseStoredSession,
  isSupabaseConfigured: () => true,
  markSupabaseAuthActive: mocks.markSupabaseAuthActive,
  refreshSupabaseSessionOnce: mocks.refreshSupabaseSessionOnce,
  subscribeSupabaseAuthExpired: vi.fn(() => vi.fn()),
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

const StateRecorder = ({ states }) => {
  const { displayName, isAuthenticated, loading } = useAuth()
  states.push(loading ? 'loading' : isAuthenticated ? `signed-in:${displayName}` : 'signed-out')
  return null
}

const RoleProbe = () => {
  const {
    role,
    assignedRoles,
    setActiveRole,
    canManageClaims,
    canDeleteNhisClaims,
  } = useAuth()
  return (
    <>
      <label>
        Active role
        <select value={role} onChange={(event) => setActiveRole(event.target.value)}>
          {assignedRoles.map((assignedRole) => (
            <option key={assignedRole} value={assignedRole}>{assignedRole}</option>
          ))}
        </select>
      </label>
      <span data-testid="claim-access">{canManageClaims ? 'claims' : 'no-claims'}</span>
      <span data-testid="delete-access">{canDeleteNhisClaims ? 'delete' : 'no-delete'}</span>
    </>
  )
}

const SignInProbe = ({ onResult }) => {
  const { signIn } = useAuth()

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await signIn('staff@example.com', 'password')
          onResult('ok')
        } catch (error) {
          onResult(error.message)
        }
      }}
    >
      Sign in
    </button>
  )
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
    mocks.queryBuilder.select.mockImplementation(() => mocks.queryBuilder)
    mocks.queryBuilder.eq.mockImplementation(() => mocks.queryBuilder)
    mocks.auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: {
        status: 400,
        name: 'AuthApiError',
        message: 'refresh token is invalid',
      },
    })
  })

  it('switches only among roles assigned to the signed-in user', async () => {
    const validUser = {
      id: 'multi-role-user',
      email: 'staff@example.com',
      app_metadata: { role: 'assistant' },
      user_metadata: { full_name: 'Multi Role User' },
    }
    const validSession = { access_token: 'fresh-token', user: validUser }
    mocks.auth.getSession.mockResolvedValue({ data: { session: validSession }, error: null })
    mocks.auth.getUser.mockResolvedValue({ data: { user: validUser }, error: null })
    mocks.queryBuilder.maybeSingle.mockResolvedValue({
      data: {
        id: validUser.id,
        full_name: 'Multi Role User',
        role: 'assistant',
        assigned_roles: ['assistant', 'claims_officer'],
        can_manage_claims: true,
        can_delete_nhis_claims: true,
        is_active: true,
      },
      error: null,
    })

    render(
      <AuthProvider>
        <RoleProbe />
      </AuthProvider>
    )

    const roleSelect = await screen.findByLabelText('Active role')
    expect(roleSelect).toHaveValue('assistant')
    expect(screen.getByTestId('claim-access')).toHaveTextContent('no-claims')
    expect(screen.getByTestId('delete-access')).toHaveTextContent('no-delete')
    fireEvent.change(roleSelect, { target: { value: 'claims_officer' } })
    expect(roleSelect).toHaveValue('claims_officer')
    expect(screen.getByTestId('claim-access')).toHaveTextContent('claims')
    expect(screen.getByTestId('delete-access')).toHaveTextContent('delete')
    expect(window.localStorage.getItem('healthflow.active-role.multi-role-user'))
      .toBe('claims_officer')
    expect(window.localStorage.getItem('healthflow.active-role.current'))
      .toBe('claims_officer')
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

  it('retries transient sign-in failures and shows a reachable-service message', async () => {
    const onResult = vi.fn()
    mocks.auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    mocks.auth.signInWithPassword
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    render(
      <AuthProvider>
        <SignInProbe onResult={onResult} />
      </AuthProvider>
    )

    await screen.findByText('Sign in')

    await act(async () => {
      fireEvent.click(screen.getByText('Sign in'))
      await new Promise((resolve) => setTimeout(resolve, 900))
    })

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith('Unable to reach authentication service. Please try again.')
    })
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledTimes(2)
  })

  it('finishes bootstrap as signed out when the stored session cannot be read', async () => {
    mocks.auth.getSession.mockRejectedValue({
      status: 401,
      name: 'AuthSessionMissingError',
      message: 'session missing',
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-out')
    })
    expect(mocks.auth.getUser).not.toHaveBeenCalled()
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
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

  it('refreshes an expired bootstrap session before validating the user', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expiredUser = {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { full_name: 'Admin User' },
    }
    const expiredSession = {
      access_token: 'expired-token',
      expires_at: now - 60,
      user: expiredUser,
    }
    const refreshedSession = {
      access_token: 'fresh-token',
      expires_at: now + 3600,
      user: expiredUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: expiredSession },
      error: null,
    })
    mocks.auth.refreshSession.mockResolvedValue({
      data: { session: refreshedSession },
      error: null,
    })
    mocks.auth.getUser.mockResolvedValue({
      data: { user: expiredUser },
      error: null,
    })
    mocks.queryBuilder.maybeSingle.mockResolvedValue({
      data: {
        id: expiredUser.id,
        email: expiredUser.email,
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
    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })

  it('retries user validation after refreshing an invalid JWT', async () => {
    const validUser = {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { full_name: 'Admin User' },
    }
    const staleSession = {
      access_token: 'stale-token',
      user: validUser,
    }
    const refreshedSession = {
      access_token: 'fresh-token',
      user: validUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: staleSession },
      error: null,
    })
    mocks.auth.refreshSession.mockResolvedValue({
      data: { session: refreshedSession },
      error: null,
    })
    mocks.auth.getUser
      .mockResolvedValueOnce({
        data: { user: null },
        error: {
          status: 403,
          name: 'AuthApiError',
          message: 'invalid JWT: token has invalid claims: token is expired',
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
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })
    expect(mocks.auth.getUser).toHaveBeenCalledTimes(2)
    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })

  it('clears a stored session when user validation returns a plain 403', async () => {
    const staleSession = {
      access_token: 'stale-token',
      user: { id: 'stale-user', email: 'stale@example.com' },
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: staleSession },
      error: null,
    })
    mocks.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: {
        status: 403,
        message: 'Forbidden',
      },
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-out')
    })
    expect(mocks.auth.refreshSession).toHaveBeenCalledTimes(1)
    expect(mocks.clearSupabaseStoredSession).toHaveBeenCalledTimes(1)
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

  it('keeps the current session when Supabase auth validation temporarily fails to fetch', async () => {
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
        error: new TypeError('Failed to fetch'),
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

  it('does not remount protected content for a background token refresh', async () => {
    const states = []
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
        <StateRecorder states={states} />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(states.at(-1)).toBe('signed-in:Admin User')
    })
    states.length = 0

    await act(async () => {
      mocks.getAuthStateChangeCallback()?.('TOKEN_REFRESHED', validSession)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(states.at(-1)).toBe('signed-in:Admin User')
    })
    expect(states).not.toContain('loading')
  })

  it('revalidates a stray sign-out event before clearing the current session', async () => {
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
      mocks.getAuthStateChangeCallback()?.('SIGNED_OUT', null)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })

  it('restores the stored session when INITIAL_SESSION is temporarily empty during bootstrap', async () => {
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

    let resolveBootstrapSession
    const bootstrapSessionPromise = new Promise((resolve) => {
      resolveBootstrapSession = resolve
    })

    mocks.auth.getSession
      .mockReturnValueOnce(bootstrapSessionPromise)
      .mockResolvedValueOnce({
        data: { session: validSession },
        error: null,
      })
      .mockResolvedValue({
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
      expect(mocks.auth.onAuthStateChange).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      mocks.getAuthStateChangeCallback()?.('INITIAL_SESSION', null)
      await Promise.resolve()
    })

    resolveBootstrapSession({
      data: { session: validSession },
      error: null,
    })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:Admin User')
    })
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })

  it('keeps password recovery sessions available for password updates without profile checks', async () => {
    const recoveryUser = {
      id: 'recovery-user',
      email: 'recovery@example.com',
      app_metadata: {},
      user_metadata: {},
    }
    const recoverySession = {
      access_token: 'recovery-token',
      user: recoveryUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: null },
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

    await act(async () => {
      mocks.getAuthStateChangeCallback()?.('PASSWORD_RECOVERY', recoverySession)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:recovery@example.com')
    })
    expect(mocks.auth.getUser).not.toHaveBeenCalled()
    expect(mocks.queryBuilder.maybeSingle).not.toHaveBeenCalled()
    expect(mocks.auth.signOut).not.toHaveBeenCalled()
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })

  it('preserves a recovery session restored from the recovery redirect URL', async () => {
    window.history.replaceState({}, '', '/login?mode=recovery')
    const recoveryUser = {
      id: 'recovery-user',
      email: 'recovery@example.com',
      app_metadata: {},
      user_metadata: {},
    }
    const recoverySession = {
      access_token: 'recovery-token',
      user: recoveryUser,
    }

    mocks.auth.getSession.mockResolvedValue({
      data: { session: recoverySession },
      error: null,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('signed-in:recovery@example.com')
    })
    expect(mocks.auth.getUser).not.toHaveBeenCalled()
    expect(mocks.queryBuilder.maybeSingle).not.toHaveBeenCalled()
    expect(mocks.auth.signOut).not.toHaveBeenCalled()
    expect(mocks.clearSupabaseStoredSession).not.toHaveBeenCalled()
  })
})
