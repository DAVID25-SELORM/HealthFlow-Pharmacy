import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  checkSubdomainAvailability,
  registerOrganizationSignup,
} from '../services/organizationService'
import './Signup.css'

const Signup = () => {
  const navigate = useNavigate()
  const { isConfigured, signIn } = useAuth()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState(
    'Your pharmacy has been registered and your 30-day free trial has started.'
  )
  const [dashboardReady, setDashboardReady] = useState(false)
  const [subdomainStatus, setSubdomainStatus] = useState(null)
  const [checkingSubdomain, setCheckingSubdomain] = useState(false)

  const [pharmacyName, setPharmacyName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [pharmacyPhone, setPharmacyPhone] = useState('')
  const [pharmacyEmail, setPharmacyEmail] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const runSubdomainCheck = async (candidate = subdomain) => {
    const normalized = candidate.trim().toLowerCase()

    if (!normalized || normalized.length < 3) {
      setSubdomainStatus(null)
      return null
    }

    setCheckingSubdomain(true)
    setSubdomainStatus(null)

    try {
      const result = await checkSubdomainAvailability(normalized)
      setSubdomainStatus(result)
      return result
    } catch (availabilityError) {
      console.error('Error checking subdomain:', availabilityError)
      const result = {
        available: false,
        message: 'Unable to check availability right now.',
      }
      setSubdomainStatus(result)
      return result
    } finally {
      setCheckingSubdomain(false)
    }
  }

  const handleSubdomainBlur = async () => {
    await runSubdomainCheck()
  }

  const validateStep1 = () => {
    if (!pharmacyName.trim()) {
      setError('Pharmacy name is required')
      return false
    }

    if (!subdomain.trim() || subdomain.length < 3) {
      setError('Subdomain must be at least 3 characters')
      return false
    }

    return true
  }

  const validateStep2 = () => {
    if (!fullName.trim()) {
      setError('Full name is required')
      return false
    }

    if (!email.trim() || !email.includes('@')) {
      setError('Valid email is required')
      return false
    }

    if (!password || password.length < 6) {
      setError('Password must be at least 6 characters')
      return false
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return false
    }

    return true
  }

  const handleStep1Next = async () => {
    setError('')

    if (!validateStep1()) {
      return
    }

    const availability = await runSubdomainCheck()
    if (!availability?.available) {
      setError(availability?.message || 'Please choose an available subdomain')
      return
    }

    setStep(2)
  }

  const handleStep2Submit = async (event) => {
    event.preventDefault()
    setError('')
    setDashboardReady(false)
    setSuccessMessage('Your pharmacy has been registered and your 30-day free trial has started.')

    if (!validateStep2()) {
      return
    }

    if (!isConfigured) {
      setError('Supabase credentials are not configured.')
      return
    }

    setLoading(true)

    try {
      await registerOrganizationSignup({
        pharmacyName,
        subdomain,
        pharmacyPhone,
        pharmacyEmail,
        address,
        city,
        region,
        licenseNumber,
        fullName,
        email,
        phone,
        password,
      })

      try {
        await signIn(email, password)
        setDashboardReady(true)
      } catch (signInError) {
        console.warn('Automatic sign-in after signup failed:', signInError)
        setSuccessMessage(
          'Your pharmacy has been registered. Sign in with your new admin account to access the dashboard.'
        )
      }

      setStep(3)
    } catch (signupError) {
      console.error('Signup error:', signupError)
      setError(signupError.message || 'Failed to create account. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoToDashboard = () => {
    navigate(dashboardReady ? '/dashboard' : '/login')
  }

  return (
    <div className="signup-page">
      <div className="signup-container">
        <div className="signup-header">
          <h1>HealthFlow Pharmacy</h1>
          <p>Start your 30-day free trial</p>
        </div>

        {!isConfigured && (
          <div className="error-message">
            <span>Error: Supabase credentials are not configured.</span>
          </div>
        )}

        {error && (
          <div className="error-message">
            <span>Error: {error}</span>
          </div>
        )}

        {step === 1 && (
          <form
            className="signup-form"
            onSubmit={(event) => {
              event.preventDefault()
              void handleStep1Next()
            }}
          >
            <div className="step-indicator">Step 1 of 2: Pharmacy Information</div>

            <div className="form-group">
              <label htmlFor="pharmacyName">Pharmacy Name *</label>
              <input
                type="text"
                id="pharmacyName"
                value={pharmacyName}
                onChange={(event) => setPharmacyName(event.target.value)}
                placeholder="ABC Pharmacy"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="subdomain">Choose Your Subdomain *</label>
              <div className="subdomain-input">
                <input
                  type="text"
                  id="subdomain"
                  value={subdomain}
                  onChange={(event) => {
                    setSubdomain(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    setSubdomainStatus(null)
                  }}
                  onBlur={() => {
                    void handleSubdomainBlur()
                  }}
                  placeholder="abc-pharmacy"
                  required
                />
                <span className="subdomain-suffix">.healthflow.app</span>
              </div>
              {checkingSubdomain && (
                <p className="subdomain-status checking">Checking availability...</p>
              )}
              {subdomainStatus && (
                <p
                  className={`subdomain-status ${
                    subdomainStatus.available ? 'available' : 'unavailable'
                  }`}
                >
                  {subdomainStatus.message}
                </p>
              )}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="pharmacyPhone">Phone</label>
                <input
                  type="tel"
                  id="pharmacyPhone"
                  value={pharmacyPhone}
                  onChange={(event) => setPharmacyPhone(event.target.value)}
                  placeholder="+233 123 456 789"
                />
              </div>

              <div className="form-group">
                <label htmlFor="pharmacyEmail">Email</label>
                <input
                  type="email"
                  id="pharmacyEmail"
                  value={pharmacyEmail}
                  onChange={(event) => setPharmacyEmail(event.target.value)}
                  placeholder="info@pharmacy.com"
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="address">Address</label>
              <input
                type="text"
                id="address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="123 Main Street"
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="city">City</label>
                <input
                  type="text"
                  id="city"
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                  placeholder="Accra"
                />
              </div>

              <div className="form-group">
                <label htmlFor="region">Region</label>
                <input
                  type="text"
                  id="region"
                  value={region}
                  onChange={(event) => setRegion(event.target.value)}
                  placeholder="Greater Accra"
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="licenseNumber">Pharmacy License Number</label>
              <input
                type="text"
                id="licenseNumber"
                value={licenseNumber}
                onChange={(event) => setLicenseNumber(event.target.value)}
                placeholder="PL-12345"
              />
            </div>

            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={loading || !isConfigured}>
                Next Step
              </button>
              <button
                type="button"
                className="btn-link"
                onClick={() => navigate('/login')}
              >
                Already have an account? Login
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form className="signup-form" onSubmit={handleStep2Submit}>
            <div className="step-indicator">Step 2 of 2: Admin Account</div>

            <div className="form-group">
              <label htmlFor="fullName">Full Name *</label>
              <input
                type="text"
                id="fullName"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="John Doe"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="email">Email Address *</label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="john@example.com"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="phone">Phone Number</label>
              <input
                type="tel"
                id="phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+233 123 456 789"
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password *</label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 6 characters"
                required
                minLength={6}
              />
            </div>

            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password *</label>
              <input
                type="password"
                id="confirmPassword"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Re-enter password"
                required
              />
            </div>

            <div className="form-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setStep(1)}
                disabled={loading || !isConfigured}
              >
                Back
              </button>
              <button type="submit" className="btn-primary" disabled={loading || !isConfigured}>
                {loading ? 'Creating Account...' : 'Create Account'}
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div className="signup-success">
            <div className="success-icon">OK</div>
            <h2>Account Created Successfully!</h2>
            <p>{successMessage}</p>
            <div className="success-details">
              <p>
                <strong>Pharmacy:</strong> {pharmacyName}
              </p>
              <p>
                <strong>Subdomain:</strong> {subdomain}.healthflow.app
              </p>
              <p>
                <strong>Admin Email:</strong> {email}
              </p>
            </div>
            <button className="btn-primary" onClick={handleGoToDashboard}>
              {dashboardReady ? 'Go to Dashboard' : 'Go to Login'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default Signup
