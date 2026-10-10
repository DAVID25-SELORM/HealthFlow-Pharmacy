import Dashboard from './Dashboard'
import SuperAdminDashboard from './SuperAdminDashboard'
import { useAuth } from '../context/AuthContext'
import DashboardBills from '../components/DashboardBills'

const DashboardHome = () => {
  const { role } = useAuth()

  if (role === 'super_admin') {
    return <SuperAdminDashboard />
  }

  return <><DashboardBills /><Dashboard /></>
}

export default DashboardHome
