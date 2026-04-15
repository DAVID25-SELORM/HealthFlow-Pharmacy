import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Lock, Mail } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useNotification } from '../context/NotificationContext'
import './Login.css'

const Login = () => {
  const { signIn, requestPasswordReset, isAuthenticated, isConfigured } = useAuth()
  const { notify } = useNotification()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('sign-in')

  if (isAuthenticated) {
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
        notify('Password reset email sent. Check your inbox.', 'success')
        setMode('sign-in')
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
      <div className="login-card">
        <h1>HealthFlow Pharmacy</h1>
        <p className="subtitle">{mode === 'reset' ? 'Reset your password' : 'Sign in to continue'}</p>

        {!isConfigured && (
          <div className="login-alert">Supabase credentials are not configured in your .env file.</div>
        )}

        {error && <div className="login-alert">{error}</div>}

        <form onSubmit={handleSubmit} className="login-form">
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

          {mode === 'sign-in' && (
            <label>
              Password
              <div className="input-wrap">
                <Lock size={16} />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  required
                />
              </div>
            </label>
          )}

          <button type="submit" disabled={submitting || !isConfigured}>
            {submitting ? 'Please wait...' : mode === 'reset' ? 'Send Reset Email' : 'Sign in'}
          </button>

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
        </form>
      </div>
    </div>
  )
}

export default Login
