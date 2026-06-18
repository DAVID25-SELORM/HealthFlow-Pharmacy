import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import Seo from '../components/Seo/Seo'
import { ArrowRight, Lock, Mail, ShoppingBag } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import './Login.css'

const LOGIN_BUILD_STAMP = 'HF-2026-06-08-branch-sync-v1'

const hasRecoveryHint = () => {
  if (typeof window === 'undefined') {
    return false
  }

  const params = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return params.get('mode') === 'recovery' || hash.get('type') === 'recovery'
}

const getRecoveryLinkError = () => {
  if (typeof window === 'undefined') {
    return ''
  }

  const params = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const code = params.get('error_code') || hash.get('error_code')
  const description = params.get('error_description') || hash.get('error_description')

  if (!code && !description) {
    return ''
  }

  const readableDescription = description?.replace(/\+/g, ' ')
  if (code === 'otp_expired' || /expired|invalid/i.test(readableDescription || '')) {
    return 'This reset link has expired or has already been used. Request a fresh password reset link below.'
  }

  return readableDescription || 'This password reset link could not be verified. Request a fresh password reset link below.'
}

const Login = () => {
  const { signIn, signOut, requestPasswordReset, updatePassword, isAuthenticated, isConfigured, loading } = useAuth()
  const { notify } = useNotification()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(() => getRecoveryLinkError())
  const [mode, setMode] = useState(() =>
    getRecoveryLinkError() ? 'reset' : hasRecoveryHint() ? 'new-password' : 'sign-in'
  )

  if (isAuthenticated && mode !== 'new-password') {
    return <Navigate to="/dashboard" replace />
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')

    try {
      setSubmitting(true)

      if (mode === 'reset') {
        if (!email.trim()) {
          setError('Email is required for password reset.')
          return
        }
        await requestPasswordReset(email)
        notify(
          'Password reset email sent. Open the link in your inbox or spam folder, then create a new password.',
          'success',
          6000
        )
        setMode('sign-in')
        return
      }

      if (mode === 'new-password') {
        if (loading || !isAuthenticated) {
          setError('Your reset link is still being verified. Please wait a moment and try again.')
          return
        }

        if (password.length < 6) {
          setError('New password must be at least 6 characters.')
          return
        }

        if (password !== confirmPassword) {
          setError('The two password entries do not match.')
          return
        }

        await updatePassword(password)
        notify('Password updated successfully. Please sign in with your new password.', 'success')
        await signOut().catch(() => null)
        setPassword('')
        setConfirmPassword('')
        setMode('sign-in')
        navigate('/login', { replace: true })
        return
      }

      if (!email.trim() || !password.trim()) {
        setError('Email and password are required.')
        return
      }

      await signIn(email, password)
    } catch (authError) {
      setError(authError.message || 'Unable to sign in. Please check your credentials.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <Seo
        title="Sign In"
        description="Sign in to HealthFlow — the pharmacy, claims, NHIS, inventory, and facility operations platform."
        path="/login"
      />
      <div className="login-card">
        <img
          src="/app-logo-display.jpg"
          alt="HealthFlow logo"
          className="auth-brand-logo"
          width="640"
          height="320"
          fetchPriority="high"
        />
        <h1>{mode === 'sign-in' ? 'Staff Portal' : 'HealthFlow'}</h1>
        <p className="subtitle">
          {mode === 'reset'
            ? 'Enter your email to receive a reset link'
            : mode === 'new-password'
              ? 'Create a new password for your account'
              : 'Sign in to manage pharmacy and facility operations'}
        </p>
        <p className="login-build-stamp">Build {LOGIN_BUILD_STAMP}</p>

        {!isConfigured && (
          <div className="login-alert">Supabase credentials are not configured in your .env file.</div>
        )}

        {error && <div className="login-alert">{error}</div>}

        <form onSubmit={handleSubmit} className="login-form">
          {mode === 'new-password' && loading && (
            <div className="login-info">Verifying your password reset link...</div>
          )}

          {mode !== 'new-password' && (
            <label>
              Email
              <div className="input-wrap">
                <Mail size={16} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </div>
            </label>
          )}

          {mode !== 'reset' && (
            <label>
              {mode === 'new-password' ? 'New Password' : 'Password'}
              <div className="input-wrap">
                <Lock size={16} />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'new-password' ? 'Enter new password' : 'Enter password'}
                  autoComplete={mode === 'new-password' ? 'new-password' : 'current-password'}
                  required
                />
              </div>
            </label>
          )}

          {mode === 'new-password' && (
            <label>
              Confirm New Password
              <div className="input-wrap">
                <Lock size={16} />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                  required
                />
              </div>
            </label>
          )}

          <button
            type="submit"
            disabled={submitting || !isConfigured || (mode === 'new-password' && loading)}
          >
            {submitting
              ? 'Please wait...'
              : mode === 'reset'
                ? 'Send Password Reset Link'
                : mode === 'new-password'
                  ? 'Update Password'
                  : 'Sign in'}
          </button>

          {mode !== 'new-password' && (
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setError('')
                setMode((current) => (current === 'sign-in' ? 'reset' : 'sign-in'))
              }}
            >
              {mode === 'sign-in' ? 'Forgot password?' : 'Back to sign in'}
            </button>
          )}
        </form>

        {mode === 'sign-in' && (
          <div className="customer-entry">
            <div className="customer-entry-divider">
              <span>For customers</span>
            </div>
            <Link to="/shop" className="customer-entry-link">
              <span className="customer-entry-icon" aria-hidden="true">
                <ShoppingBag size={20} />
              </span>
              <span className="customer-entry-copy">
                <strong>Shop for medicines</strong>
                <small>Browse available medicines from licensed pharmacies</small>
              </span>
              <ArrowRight size={19} aria-hidden="true" />
            </Link>
          </div>
        )}
        <p className="powered-by">
          Powered by{' '}
          <a href="https://neondigitaltechnologies.com" target="_blank" rel="noreferrer">
            Neon Digital Technologies
          </a>
        </p>
      </div>
    </div>
  )
}

export default Login
