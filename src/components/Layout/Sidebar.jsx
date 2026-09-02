import { Link, NavLink } from 'react-router-dom'
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
  Activity,
  RefreshCcw,
  MonitorCheck,
  Trash2,
  LifeBuoy,
  Gauge,
  Download,
  ShieldAlert,
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
  PATIENT_CARE_ROLES,
  PATIENT_ROLES,
  REPORT_ROLES,
  SALES_ROLES,
  SETTINGS_ROLES,
  SYSTEM_HEALTH_ROLES,
  hasRole,
} from '../../utils/roles'
import { getFacilityLogo, getFacilityName } from '../../utils/facilityBranding'
import { preloadRouteModule } from '../../routes/routeModules'
import './Sidebar.css'

const Sidebar = ({ isOpen, onClose }) => {
  const {
    role,
    canManageInventory,
    canViewReports,
    canManageClaims,
    canManagePurchases,
    canProcessSales,
    canManagePatients,
    canManageAccounting,
    canManageEpharmacy,
    canViewActivityLog,
    canManageRestrictedInventory,
  } = useAuth()
  const { organization, canUseClaims, canUsePurchases, canUseNhis, canUseAccounting } = useTenant()
  const isChemicalShop = organization?.organization_type === 'chemical_shop'
  const facilityName = getFacilityName(organization)
  const facilityLogo = getFacilityLogo(organization) || '/app-logo-display.jpg'

  const menuItems = [
    {
      path: '/dashboard',
      icon: Home,
      label: role === 'super_admin' ? 'Platform Dashboard' : 'Dashboard',
      roles: DASHBOARD_ROLES,
    },
    { path: '/inventory', icon: Package, label: 'Inventory', roles: INVENTORY_ROLES, allow: canManageInventory },
    { path: '/sales', icon: ShoppingCart, label: 'Sales (POS)', roles: SALES_ROLES, allow: canProcessSales },
    { path: '/patients', icon: Users, label: 'Patients', roles: PATIENT_ROLES, allow: canManagePatients, featureAllowed: !isChemicalShop },
    { path: '/claims', icon: ClipboardList, label: 'Claims', roles: CLAIMS_ROLES, allow: canManageClaims, featureAllowed: canUseClaims },
    {
      path: '/purchases',
      icon: Truck,
      label: 'Purchases',
      roles: ['admin', 'super_admin'],
      allow: canManagePurchases,
      featureAllowed: canUsePurchases,
    },
    { path: '/e-pharmacy', icon: Building2, label: 'E-Pharmacy', roles: EPHARMACY_ROLES, allow: canManageEpharmacy },
    { path: '/nhis', icon: HeartPulse, label: 'NHIS', roles: NHIS_ROLES, featureAllowed: !isChemicalShop && canUseNhis },
    { path: '/patient-care', icon: Activity, label: 'Patient Care', roles: PATIENT_CARE_ROLES, featureAllowed: !isChemicalShop },
    { path: '/reports', icon: BarChart3, label: 'Reports', roles: REPORT_ROLES, allow: canViewReports },
    { path: '/accounting', icon: Wallet, label: 'Accounting', roles: ACCOUNTING_ROLES, allow: canManageAccounting, featureAllowed: canUseAccounting },
    { path: '/settings', icon: Settings, label: 'Settings', roles: SETTINGS_ROLES },
    { path: '/recycle-bin', icon: Trash2, label: 'Recycle Bin', roles: ['admin', 'super_admin'] },
    {
      path: '/restricted-inventory',
      icon: ShieldAlert,
      label: 'Restricted Inventory',
      roles: ['super_admin', 'compliance_admin', 'compliance_officer'],
      allow: canManageRestrictedInventory,
      featureAllowed:
        isChemicalShop ||
        ['super_admin', 'compliance_admin', 'compliance_officer'].includes(role),
    },
    { path: '/system-health', icon: MonitorCheck, label: 'System Health', roles: SYSTEM_HEALTH_ROLES },
    { path: '/diagnostics', icon: Gauge, label: 'Diagnostics', roles: ['super_admin'] },
    { path: '/offline-installer-releases', icon: Download, label: 'Installer Releases', roles: ['super_admin'] },
    { path: '/offline-sync', icon: RefreshCcw, label: 'Offline Sync', roles: OFFLINE_SYNC_ROLES },
    { path: '/support', icon: LifeBuoy, label: 'Support', roles: ['admin', 'super_admin', 'pharmacist', 'cashier', 'assistant'] },
    { path: '/tenant-admin', icon: ShieldCheck, label: 'Tenant Admin', roles: ['super_admin'] },
    { path: '/activity-log', icon: List, label: 'Activity Log', roles: ACTIVITY_LOG_ROLES, allow: canViewActivityLog },
  ]

  const visibleItems = menuItems.filter(
    (item) => item.featureAllowed !== false && (hasRole(role, item.roles) || item.allow)
  )

  return (
    <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-logo">
        <img src={facilityLogo} alt={`${facilityName} logo`} className="sidebar-brand-logo" />
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
            onMouseEnter={() => preloadRouteModule(item.path)}
            onFocus={() => preloadRouteModule(item.path)}
            onTouchStart={() => preloadRouteModule(item.path)}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p>{facilityName}</p>
        <p className="developer">{organization?.organization_type || 'Facility'} workspace</p>
        <Link className="sidebar-terms-link" to="/terms" onClick={onClose}>
          Terms and Conditions
        </Link>
        <a
          className="sidebar-powered-by"
          href="https://neondigitaltechnologies.com"
          target="_blank"
          rel="noreferrer"
        >
          Powered by Daventra Technologies
        </a>
      </div>
    </aside>
  )
}

export default Sidebar
