export const routeModuleLoaders = {
  '/dashboard': () => import('../pages/DashboardHome'),
  '/inventory': () => import('../pages/Inventory'),
  '/sales': () => import('../pages/Sales'),
  '/patients': () => import('../pages/Patients'),
  '/claims': () => import('../pages/Claims'),
  '/reports': () => import('../pages/Reports'),
  '/accounting': () => import('../pages/Accounting'),
  '/settings': () => import('../pages/Settings'),
  '/tenant-admin': () => import('../pages/TenantAdmin'),
  '/activity-log': () => import('../pages/ActivityLog'),
  '/system-health': () => import('../pages/SystemHealth'),
  '/diagnostics': () => import('../pages/Diagnostics'),
  '/offline-installer-releases': () => import('../pages/OfflineInstallerReleases'),
  '/offline-sync': () => import('../pages/OfflineSync'),
  '/support': () => import('../pages/Support'),
  '/purchases': () => import('../pages/Purchases'),
  '/nhis': () => import('../pages/Nhis'),
  '/e-pharmacy': () => import('../pages/EPharmacy'),
  '/patient-care': () => import('../pages/PatientCare'),
  '/recycle-bin': () => import('../pages/RecycleBin'),
  '/restricted-inventory': () => import('../pages/RestrictedInventory'),
}

const routeModulePromises = new Map()

export const loadRouteModule = (path) => {
  const loader = routeModuleLoaders[path]
  if (!loader) return Promise.resolve(null)
  if (!routeModulePromises.has(path)) {
    routeModulePromises.set(path, loader().catch((error) => {
      routeModulePromises.delete(path)
      throw error
    }))
  }
  return routeModulePromises.get(path)
}

export const preloadRouteModule = (path) => {
  void loadRouteModule(path).catch(() => {})
}
