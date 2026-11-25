import {
  Home,
  Package,
  ShoppingCart,
  Users,
  ClipboardList,
  PackageSearch,
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
  ArrowRightLeft,
  ArrowUpFromLine,
} from 'lucide-react'
import { isServedByOfflineServer } from '../../services/branchServerApi'
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

// The menu is grouped so a long list reads as a few short ones. Who sees an
// item is decided only by the role / feature rules on each item below, exactly
// as before; groups are presentation.
export const NAV_GROUPS = [
  { id: 'daily', label: 'Daily work', defaultOpen: true },
  { id: 'stock', label: 'Stock', defaultOpen: true },
  { id: 'claims', label: 'Claims', defaultOpen: true },
  { id: 'business', label: 'Business', defaultOpen: false },
  { id: 'admin', label: 'Admin', defaultOpen: false },
]

export const groupNavigationItems = (items = []) =>
  NAV_GROUPS
    .map((group) => ({ ...group, items: items.filter((item) => item.group === group.id) }))
    .filter((group) => group.items.length > 0)

const TAB_SHORT_LABELS = {
  '/dashboard': 'Home',
  '/inventory': 'Stock',
  '/sales': 'Sales',
  '/nhis': 'NHIS',
  '/patients': 'Patients',
  '/claims': 'Claims',
  '/reports': 'Reports',
  '/purchases': 'Purchases',
}

const TAB_PREFERENCE = ['/dashboard', '/inventory', '/nhis', '/patients', '/claims', '/reports', '/purchases']

// The phone's bottom bar: the few places used all day, from whatever this user can open.
// Sales sits in the middle (raised) when there are four tabs around it.
export const pickBottomTabs = (items = []) => {
  const byPath = new Map(items.map((item) => [item.path, item]))
  const sales = byPath.get('/sales')
  const others = TAB_PREFERENCE.map((path) => byPath.get(path)).filter(Boolean)
  const side = others.slice(0, sales ? 3 : 4)
  let tabs
  if (sales && side.length >= 2) tabs = [side[0], side[1], sales, ...side.slice(2)]
  else if (sales) tabs = [...side, sales]
  else tabs = side
  const withLabels = tabs.map((item) => ({ ...item, tabLabel: TAB_SHORT_LABELS[item.path] || item.label }))
  const raisedIndex = sales && withLabels.length === 4 && withLabels[2].path === '/sales' ? 2 : -1
  const tabPaths = new Set(withLabels.map((item) => item.path))
  return {
    tabs: withLabels,
    raisedIndex,
    moreItems: items.filter((item) => !tabPaths.has(item.path)),
  }
}

export const useNavigationItems = () => {
  const {
    role,
    assignedRoles,
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
      group: 'daily',
      roles: DASHBOARD_ROLES,
    },
    { path: '/billing', icon: Wallet, label: 'Payments', group: 'business', roles: ['admin', 'super_admin'], allow: assignedRoles?.includes('admin') },
    { path: '/export-notifications', icon: ClipboardList, label: 'Export notifications', group: 'business', roles: ['admin', 'super_admin'], allow: assignedRoles?.includes('admin') },
    { path: '/inventory', icon: Package, label: 'Inventory', group: 'stock', roles: INVENTORY_ROLES, allow: canManageInventory },
    { path: '/stock-transfers', icon: ArrowRightLeft, label: 'Stock Transfers', group: 'stock', roles: INVENTORY_ROLES, allow: canManageInventory, featureAllowed: !isChemicalShop },
    { path: '/sales', icon: ShoppingCart, label: 'Sales (POS)', group: 'daily', roles: SALES_ROLES, allow: canProcessSales },
    { path: '/patients', icon: Users, label: 'Patients', group: 'daily', roles: PATIENT_ROLES, allow: canManagePatients, featureAllowed: !isChemicalShop },
    { path: '/nhis', icon: HeartPulse, label: 'NHIS', group: 'claims', roles: NHIS_ROLES, featureAllowed: !isChemicalShop && canUseNhis },
    { path: '/claims', icon: ClipboardList, label: 'Claims', group: 'claims', roles: CLAIMS_ROLES, allow: canManageClaims, featureAllowed: canUseClaims },
    {
      path: '/purchases',
      icon: Truck,
      label: 'Purchases',
      group: 'stock',
      roles: ['admin', 'super_admin'],
      allow: canManagePurchases,
      featureAllowed: canUsePurchases,
    },
    {
      path: '/reorder',
      icon: PackageSearch,
      label: 'Reorder Centre',
      group: 'stock',
      roles: ['admin', 'super_admin'],
      allow: canManagePurchases,
      featureAllowed: canUsePurchases,
    },
    { path: '/e-pharmacy', icon: Building2, label: 'E-Pharmacy', group: 'claims', roles: EPHARMACY_ROLES, allow: canManageEpharmacy },
    { path: '/patient-care', icon: Activity, label: 'Patient Care', group: 'daily', roles: PATIENT_CARE_ROLES, featureAllowed: !isChemicalShop },
    { path: '/reports', icon: BarChart3, label: 'Reports', group: 'business', roles: REPORT_ROLES, allow: canViewReports },
    { path: '/accounting', icon: Wallet, label: 'Accounting', group: 'business', roles: ACCOUNTING_ROLES, allow: canManageAccounting, featureAllowed: canUseAccounting },
    { path: '/settings', icon: Settings, label: 'Settings', group: 'admin', roles: SETTINGS_ROLES },
    { path: '/recycle-bin', icon: Trash2, label: 'Recycle Bin', group: 'admin', roles: ['admin', 'super_admin'] },
    {
      path: '/restricted-inventory',
      icon: ShieldAlert,
      label: 'Restricted Inventory',
      group: 'stock',
      roles: ['super_admin', 'compliance_admin', 'compliance_officer'],
      allow: canManageRestrictedInventory,
      featureAllowed:
        isChemicalShop ||
        ['super_admin', 'compliance_admin', 'compliance_officer'].includes(role),
    },
    { path: '/system-health', icon: MonitorCheck, label: 'System Health', group: 'admin', roles: SYSTEM_HEALTH_ROLES },
    { path: '/diagnostics', icon: Gauge, label: 'Diagnostics', group: 'admin', roles: ['super_admin'] },
    { path: '/offline-installer-releases', icon: Download, label: 'Installer Releases', group: 'admin', roles: ['super_admin'] },
    { path: '/offline-sync', icon: RefreshCcw, label: 'Offline Sync', group: 'admin', roles: OFFLINE_SYNC_ROLES },
    { path: '/support', icon: LifeBuoy, label: 'Support', group: 'admin', roles: ['admin', 'super_admin', 'pharmacist', 'cashier', 'assistant'] },
    { path: '/tenant-admin', icon: ShieldCheck, label: 'Tenant Admin', group: 'admin', roles: ['super_admin'] },
    { path: '/activity-log', icon: List, label: 'Activity Log', group: 'admin', roles: ACTIVITY_LOG_ROLES, allow: canViewActivityLog },
    // Offline version only. Everyone sees it (in an open group) so a waiting update is not hidden from anyone.
    { path: '/updates', icon: ArrowUpFromLine, label: 'Updates', group: 'daily', roles: [], allow: true, featureAllowed: isServedByOfflineServer() },
  ]

  const items = menuItems.filter(
    (item) => item.featureAllowed !== false && (hasRole(role, item.roles) || item.allow)
  )

  return {
    items,
    groups: groupNavigationItems(items),
    organization,
    facilityName,
    facilityLogo,
  }
}
