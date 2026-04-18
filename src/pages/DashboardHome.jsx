import Dashboard from './Dashboard'
import SuperAdminDashboard from './SuperAdminDashboard'
import { useAuth } from '../context/AuthContext'

const DashboardHome = () => {
  const { role } = useAuth()

  if (role === 'super_admin') {
    return <SuperAdminDashboard />
  }

  return <Dashboard />
}

export default DashboardHome
