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
  Truck,
  Building2,
  HeartPulse,
  RefreshCcw,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useTenant } from '../../context/TenantContext'
import {
  ACCOUNTING_ROLES,
  ACTIVITY_LOG_ROLES,
  CLAIMS_ROLES,
  DASHBOARD_ROLES,
  EPHARMACY_ROLES,
  INVENTORY_ROLES,
  NHIS_ROLES,
  OFFLINE_SYNC_ROLES,
  PATIENT_ROLES,
  PURCHASES_ROLES,
  REPORT_ROLES,
  SALES_ROLES,
  SETTINGS_ROLES,
  hasRole,
} from '../../utils/roles'
import './Sidebar.css'

const Sidebar = ({ isOpen, onClose }) => {
  const { role, canManageInventory, canViewReports, canManageClaims } = useAuth()
  const { canUseClaims, canUsePurchases, canUseNhis, canUseAccounting } = useTenant()

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
    { path: '/claims', icon: ClipboardList, label: 'Claims', roles: CLAIMS_ROLES, allow: canManageClaims, featureAllowed: canUseClaims },
    { path: '/purchases', icon: Truck, label: 'Purchases', roles: PURCHASES_ROLES, featureAllowed: canUsePurchases },
    { path: '/e-pharmacy', icon: Building2, label: 'E-Pharmacy', roles: EPHARMACY_ROLES },
    { path: '/nhis', icon: HeartPulse, label: 'NHIS', roles: NHIS_ROLES, featureAllowed: canUseNhis },
    { path: '/reports', icon: BarChart3, label: 'Reports', roles: REPORT_ROLES, allow: canViewReports },
    { path: '/accounting', icon: Wallet, label: 'Accounting', roles: ACCOUNTING_ROLES, featureAllowed: canUseAccounting },
    { path: '/settings', icon: Settings, label: 'Settings', roles: SETTINGS_ROLES },
    { path: '/offline-sync', icon: RefreshCcw, label: 'Offline Sync', roles: OFFLINE_SYNC_ROLES },
    { path: '/tenant-admin', icon: ShieldCheck, label: 'Tenant Admin', roles: ['super_admin'] },
    { path: '/activity-log', icon: List, label: 'Activity Log', roles: ACTIVITY_LOG_ROLES },
  ]

  const visibleItems = menuItems.filter(
    (item) => item.featureAllowed !== false && (hasRole(role, item.roles) || item.allow)
  )

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-logo">
        <img src="/app-logo.png" alt="HealthFlow Pharmacy" className="sidebar-brand-logo" />
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
