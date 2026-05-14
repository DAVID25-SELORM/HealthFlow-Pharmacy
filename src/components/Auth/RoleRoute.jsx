import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { hasRole } from '../../utils/roles'

const RoleRoute = ({ allowedRoles, allow, featureAllowed = true, children }) => {
  const { role } = useAuth()

  if (featureAllowed && (hasRole(role, allowedRoles) || allow)) {
    return children
  }

  return <Navigate to="/dashboard" replace />
}

export default RoleRoute
