import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

const RoleRoute = ({ allowedRoles, allow, children }) => {
  const { role } = useAuth()
  const normalizedRole = String(role || '').toLowerCase()

  if (allowedRoles.includes(normalizedRole) || allow) {
    return children
  }

  return <Navigate to="/dashboard" replace />
}

export default RoleRoute
