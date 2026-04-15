import { NavLink } from 'react-router-dom'
import { 
  X,
  Home, 
  Package, 
  ShoppingCart, 
  Users, 
  ClipboardList, 
  BarChart3, 
  Settings 
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import './Sidebar.css'

const Sidebar = ({ isOpen, onClose }) => {
  const { role } = useAuth()

  const menuItems = [
    { path: '/dashboard', icon: Home, label: 'Dashboard', roles: ['admin', 'pharmacist', 'assistant'] },
    { path: '/inventory', icon: Package, label: 'Inventory', roles: ['admin', 'pharmacist'] },
    { path: '/sales', icon: ShoppingCart, label: 'Sales (POS)', roles: ['admin', 'pharmacist', 'assistant'] },
    { path: '/patients', icon: Users, label: 'Patients', roles: ['admin', 'pharmacist', 'assistant'] },
    { path: '/claims', icon: ClipboardList, label: 'Claims', roles: ['admin', 'pharmacist'] },
    { path: '/reports', icon: BarChart3, label: 'Reports', roles: ['admin', 'pharmacist'] },
    { path: '/settings', icon: Settings, label: 'Settings', roles: ['admin'] },
  ]

  const visibleItems = menuItems.filter((item) => item.roles.includes(role))

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
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
        <button type="button" className="sidebar-close" onClick={onClose} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <nav className="sidebar-nav">
        {visibleItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={onClose}
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
