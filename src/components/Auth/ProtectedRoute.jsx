import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

const ProtectedRoute = ({ children }) => {
  const { loading, isAuthenticated, isConfigured, organization, role, signOut } = useAuth()

  if (!isConfigured) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>HealthFlow Cloud Setup Required</h2>
        <p>Configure the HealthFlow Cloud URL and publishable access key in your environment settings.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Loading session...</h2>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  const organizationStatus = String(organization?.status || '').toLowerCase()
  const billingStatus = String(organization?.billing_status || '').toLowerCase()
  const accessPaused =
    role !== 'super_admin' &&
    (['suspended', 'cancelled'].includes(organizationStatus) ||
      ['suspended', 'cancelled'].includes(billingStatus))

  if (accessPaused) {
    return (
      <div style={{ padding: '2rem', maxWidth: '640px' }}>
        <h2>Access Paused</h2>
        <p>
          This pharmacy workspace is currently {billingStatus || organizationStatus}. Contact
          your platform administrator to reactivate access.
        </p>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    )
  }

  return children
}

export default ProtectedRoute
