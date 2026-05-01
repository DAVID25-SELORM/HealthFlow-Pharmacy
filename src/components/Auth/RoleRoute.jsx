import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

const RoleRoute = ({ allowedRoles, allow, children }) => {
  const { role } = useAuth()

  if (allowedRoles.includes(role) || allow) {
    return children
  }

  return <Navigate to="/dashboard" replace />
}

export default RoleRoute
