import { NavLink } from 'react-router-dom'
import {
  X,
  Home,
  Package,
  ShoppingCart,
  Users,
  ClipboardList,
  BarChart3,
  Wallet,
  Settings,
  ShieldCheck,
  List,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import {
  ACCOUNTING_ROLES,
  ACTIVITY_LOG_ROLES,
  CLAIMS_ROLES,
  DASHBOARD_ROLES,
  INVENTORY_ROLES,
  PATIENT_ROLES,
  REPORT_ROLES,
  SALES_ROLES,
  SETTINGS_ROLES,
} from '../../utils/roles'
import './Sidebar.css'

const Sidebar = ({ isOpen, onClose }) => {
  const { role, canManageInventory, canViewReports, canManageClaims } = useAuth()

  const menuItems = [
    {
      path: '/dashboard',
      icon: Home,
      label: role === 'super_admin' ? 'Platform Dashboard' : 'Dashboard',
      roles: DASHBOARD_ROLES,
    },
    { path: '/inventory', icon: Package, label: 'Inventory', roles: INVENTORY_ROLES, allow: canManageInventory },
    { path: '/sales', icon: ShoppingCart, label: 'Sales (POS)', roles: SALES_ROLES },
    { path: '/patients', icon: Users, label: 'Patients', roles: PATIENT_ROLES },
    { path: '/claims', icon: ClipboardList, label: 'Claims', roles: CLAIMS_ROLES, allow: canManageClaims },
    { path: '/reports', icon: BarChart3, label: 'Reports', roles: REPORT_ROLES, allow: canViewReports },
    { path: '/accounting', icon: Wallet, label: 'Accounting', roles: ACCOUNTING_ROLES },
    { path: '/settings', icon: Settings, label: 'Settings', roles: SETTINGS_ROLES },
    { path: '/tenant-admin', icon: ShieldCheck, label: 'Tenant Admin', roles: ['super_admin'] },
    { path: '/activity-log', icon: List, label: 'Activity Log', roles: ACTIVITY_LOG_ROLES },
  ]

  const visibleItems = menuItems.filter((item) => item.roles.includes(role) || item.allow)

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-logo">
        <div className="logo-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="white" />
            <path d="M16 8V24M8 16H24" stroke="#16a085" strokeWidth="3" strokeLinecap="round" />
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
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p>Copyright 2026 HealthFlow</p>
        <p className="developer">Built by David Gabion Selorm</p>
      </div>
    </aside>
  )
}

export default Sidebar
