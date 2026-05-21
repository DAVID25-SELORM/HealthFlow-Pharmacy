const warmOfflineRouteChunks = async () => {
  await Promise.allSettled([
    import('./components/Layout/Layout'),
    import('./pages/DashboardHome'),
    import('./pages/Inventory'),
    import('./pages/Sales'),
    import('./pages/Patients'),
    import('./pages/Claims'),
    import('./pages/Reports'),
    import('./pages/Accounting'),
    import('./pages/Settings'),
    import('./pages/TenantAdmin'),
    import('./pages/Login'),
    import('./pages/Signup'),
    import('./pages/ActivityLog'),
    import('./pages/OfflineSync'),
    import('./pages/Purchases'),
    import('./pages/Nhis'),
    import('./data/diagnosisCatalog.js'),
  ])
}

const notifyServiceWorkerAboutLoadedAssets = (registration) => {
  const serviceWorker = navigator.serviceWorker.controller || registration?.active
  if (!serviceWorker || !('performance' in window)) {
    return
  }

  const urls = performance
    .getEntriesByType('resource')
    .map((entry) => {
      try {
        const url = new URL(entry.name)
        return url.origin === window.location.origin ? `${url.pathname}${url.search}` : ''
      } catch {
        return ''
      }
    })
    .filter(Boolean)

  serviceWorker.postMessage({
    type: 'HEALTHFLOW_PRECACHE_URLS',
    urls: ['/', '/index.html', ...urls],
  })
}

const registerServiceWorker = () => {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then(async (registration) => {
        const readyRegistration = await navigator.serviceWorker.ready
        await warmOfflineRouteChunks()
        notifyServiceWorkerAboutLoadedAssets(readyRegistration || registration)
      })
      .catch((error) => {
        console.warn('Service worker registration failed:', error)
      })
  })
}

export default registerServiceWorker
