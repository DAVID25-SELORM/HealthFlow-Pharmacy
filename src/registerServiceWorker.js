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

let serviceWorkerReloading = false

const requestWaitingServiceWorkerActivation = (registration) => {
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'HEALTHFLOW_SKIP_WAITING' })
  }
}

const watchForServiceWorkerUpdates = (registration) => {
  registration.addEventListener('updatefound', () => {
    const nextWorker = registration.installing
    if (!nextWorker) {
      return
    }

    nextWorker.addEventListener('statechange', () => {
      if (nextWorker.state === 'installed' && navigator.serviceWorker.controller) {
        nextWorker.postMessage({ type: 'HEALTHFLOW_SKIP_WAITING' })
      }
    })
  })

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (serviceWorkerReloading) {
      return
    }
    serviceWorkerReloading = true
    window.location.reload()
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
        watchForServiceWorkerUpdates(registration)
        requestWaitingServiceWorkerActivation(registration)
        await registration.update()
        requestWaitingServiceWorkerActivation(registration)
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
