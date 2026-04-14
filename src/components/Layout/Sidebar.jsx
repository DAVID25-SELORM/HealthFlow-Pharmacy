import { NavLink } from 'react-router-dom'
import { 
  Home, 
  Package, 
  ShoppingCart, 
  Users, 
  ClipboardList, 
  BarChart3, 
  Settings 
} from 'lucide-react'
import './Sidebar.css'

const Sidebar = () => {
  const menuItems = [
    { path: '/dashboard', icon: Home, label: 'Dashboard' },
    { path: '/inventory', icon: Package, label: 'Inventory' },
    { path: '/sales', icon: ShoppingCart, label: 'Sales (POS)' },
    { path: '/patients', icon: Users, label: 'Patients' },
    { path: '/claims', icon: ClipboardList, label: 'Claims' },
    { path: '/reports', icon: BarChart3, label: 'Reports' },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ]

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="white"/>
            <path d="M16 8V24M8 16H24" stroke="#16a085" strokeWidth="3" strokeLinecap="round"/>
          </svg>
        </div>
        <div className="logo-text">
          <h2>HealthFlow</h2>
          <p>Pharmacy</p>
        </div>
      </div>

      <nav className="sidebar-nav">
        {menuItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => 
              `nav-item ${isActive ? 'active' : ''}`
            }
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p>© 2026 HealthFlow</p>
        <p className="developer">Built by David Gabion Selorm</p>
      </div>
    </aside>
  )
}

export default Sidebar
