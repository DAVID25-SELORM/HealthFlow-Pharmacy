import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

const ProtectedRoute = ({ children }) => {
  const { loading, isAuthenticated, isConfigured } = useAuth()

  if (!isConfigured) {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Supabase Setup Required</h2>
        <p>Configure VITE_SUPABASE_URL and either VITE_SUPABASE_PUBLISHABLE_KEY or VITE_SUPABASE_ANON_KEY in your .env file.</p>
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

  return children
}

export default ProtectedRoute
