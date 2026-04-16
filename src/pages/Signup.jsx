import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createOrganization, checkSubdomainAvailability } from '../services/organizationService'
import { createSettings } from '../services/settingsService'
import './Signup.css'

const Signup = () => {
  const navigate = useNavigate()
  const [step, setStep] = useState(1) // 1: Pharmacy Info, 2: Account Info, 3: Success
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [subdomainStatus, setSubdomainStatus] = useState(null)
  const [checkingSubdomain, setCheckingSubdomain] = useState(false)

  // Pharmacy Info (Step 1)
  const [pharmacyName, setPharmacyName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [pharmacyPhone, setPharmacyPhone] = useState('')
  const [pharmacyEmail, setPharmacyEmail] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [region, setRegion] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')

  // Account Info (Step 2)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const handleSubdomainBlur = async () => {
    if (!subdomain || subdomain.length < 3) {
      setSubdomainStatus(null)
      return
    }

    setCheckingSubdomain(true)
    setSubdomainStatus(null)

    try {
      const result = await checkSubdomainAvailability(subdomain)
      setSubdomainStatus(result)
    } catch (err) {
      console.error('Error checking subdomain:', err)
      setSubdomainStatus({ available: false, message: 'Error checking availability' })
    } finally {
      setCheckingSubdomain(false)
    }
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
    if (subdomainStatus && !subdomainStatus.available) {
      setError('Please choose an available subdomain')
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

  const handleStep1Next = () => {
    setError('')
    if (validateStep1()) {
      setStep(2)
    }
  }

  const handleStep2Submit = async (e) => {
    e.preventDefault()
    setError('')

    if (!validateStep2()) {
      return
    }

    setLoading(true)

    try {
      // Step 1: Create organization
      const organization = await createOrganization({
        name: pharmacyName,
        subdomain: subdomain,
        phone: pharmacyPhone,
        email: pharmacyEmail,
        address: address,
        city: city,
        region: region,
        licenseNumber: licenseNumber,
      })

      // Step 2: Create admin user account
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password: password,
        options: {
          data: {
            full_name: fullName.trim(),
            role: 'admin',
          },
        },
      })

      if (signUpError) throw signUpError

      if (!authData.user) {
        throw new Error('User creation failed')
      }

      // Step 3: Insert user into users table with organization
      const { error: userError } = await supabase.from('users').insert([
        {
          id: authData.user.id,
          email: email.trim(),
          full_name: fullName.trim(),
          phone: phone.trim() || null,
          role: 'admin',
          organization_id: organization.id,
          is_active: true,
        },
      ])

      if (userError) throw userError

      // Step 4: Update organization owner
      const { error: ownerError } = await supabase
        .from('organizations')
        .update({ owner_user_id: authData.user.id })
        .eq('id', organization.id)

      if (ownerError) throw ownerError

      // Step 5: Create default pharmacy settings
      await createSettings({
        organization_id: organization.id,
        pharmacy_name: pharmacyName,
        phone: pharmacyPhone,
        email: pharmacyEmail,
        address: address,
        city: city,
        region: region,
        license_number: licenseNumber,
      })

      // Success! Move to step 3
      setStep(3)
    } catch (err) {
      console.error('Signup error:', err)
      setError(err.message || 'Failed to create account. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoToDashboard = () => {
    navigate('/')
  }

  return (
    <div className="signup-page">
      <div className="signup-container">
        <div className="signup-header">
          <h1>HealthFlow Pharmacy</h1>
          <p>Start your 30-day free trial</p>
        </div>

        {error && (
          <div className="error-message">
            <span>⚠️ {error}</span>
          </div>
        )}

        {/* Step 1: Pharmacy Information */}
        {step === 1 && (
          <form className="signup-form" onSubmit={(e) => { e.preventDefault(); handleStep1Next(); }}>
            <div className="step-indicator">Step 1 of 2: Pharmacy Information</div>

            <div className="form-group">
              <label htmlFor="pharmacyName">Pharmacy Name *</label>
              <input
                type="text"
                id="pharmacyName"
                value={pharmacyName}
                onChange={(e) => setPharmacyName(e.target.value)}
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
                  onChange={(e) => {
                    setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    setSubdomainStatus(null)
                  }}
                  onBlur={handleSubdomainBlur}
                  placeholder="abc-pharmacy"
                  required
                />
                <span className="subdomain-suffix">.healthflow.app</span>
              </div>
              {checkingSubdomain && <p className="subdomain-status checking">Checking availability...</p>}
              {subdomainStatus && (
                <p className={`subdomain-status ${subdomainStatus.available ? 'available' : 'unavailable'}`}>
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
                  onChange={(e) => setPharmacyPhone(e.target.value)}
                  placeholder="+233 123 456 789"
                />
              </div>

              <div className="form-group">
                <label htmlFor="pharmacyEmail">Email</label>
                <input
                  type="email"
                  id="pharmacyEmail"
                  value={pharmacyEmail}
                  onChange={(e) => setPharmacyEmail(e.target.value)}
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
                onChange={(e) => setAddress(e.target.value)}
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
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Accra"
                />
              </div>

              <div className="form-group">
                <label htmlFor="region">Region</label>
                <input
                  type="text"
                  id="region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
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
                onChange={(e) => setLicenseNumber(e.target.value)}
                placeholder="PL-12345"
              />
            </div>

            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={loading}>
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

        {/* Step 2: Account Information */}
        {step === 2 && (
          <form className="signup-form" onSubmit={handleStep2Submit}>
            <div className="step-indicator">Step 2 of 2: Admin Account</div>

            <div className="form-group">
              <label htmlFor="fullName">Full Name *</label>
              <input
                type="text"
                id="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
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
                onChange={(e) => setEmail(e.target.value)}
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
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+233 123 456 789"
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password *</label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                required
              />
            </div>

            <div className="form-actions">
              <button 
                type="button" 
                className="btn-secondary" 
                onClick={() => setStep(1)}
                disabled={loading}
              >
                Back
              </button>
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Creating Account...' : 'Create Account'}
              </button>
            </div>
          </form>
        )}

        {/* Step 3: Success */}
        {step === 3 && (
          <div className="signup-success">
            <div className="success-icon">✓</div>
            <h2>Account Created Successfully!</h2>
            <p>Your pharmacy has been registered and your 30-day free trial has started.</p>
            <div className="success-details">
              <p><strong>Pharmacy:</strong> {pharmacyName}</p>
              <p><strong>Subdomain:</strong> {subdomain}.healthflow.app</p>
              <p><strong>Admin Email:</strong> {email}</p>
            </div>
            <button className="btn-primary" onClick={handleGoToDashboard}>
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default Signup
