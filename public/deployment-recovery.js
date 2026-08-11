(() => {
  const RELOAD_KEY = 'healthflow_deployment_asset_recovery_at'
  const RELOAD_COOLDOWN_MS = 30_000
  let recovering = false

  const isDeploymentAssetFailure = (value = '') => {
    const message = String(value || '').toLowerCase()
    return (
      message.includes('failed to fetch dynamically imported module') ||
      message.includes('error loading dynamically imported module') ||
      message.includes('importing a module script failed') ||
      message.includes('failed to load module script') ||
      (message.includes('/assets/') && (message.includes('404') || message.includes('mime type')))
    )
  }

  const isHashedAssetElement = (target) => {
    const url = target?.src || target?.href || ''
    return Boolean(url && /\/assets\/[^/?]+\.(?:js|css)(?:[?#]|$)/i.test(url))
  }

  const recoverLatestDeployment = async () => {
    if (recovering) return
    const lastReloadAt = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) return

    recovering = true
    const recoveryAt = Date.now()
    window.sessionStorage.setItem(RELOAD_KEY, String(recoveryAt))

    try {
      if ('caches' in window) {
        const cacheNames = await window.caches.keys()
        await Promise.all(
          cacheNames
            .filter((name) => name.startsWith('healthflow-'))
            .map((name) => window.caches.delete(name))
        )
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations()
        await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)))
      }
    } catch {
      // A cache API failure must not prevent the cache-busted navigation.
    }

    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('__healthflow_refresh', String(recoveryAt))
    window.location.replace(nextUrl.toString())
  }

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    void recoverLatestDeployment()
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason?.message || event.reason || ''
    if (isDeploymentAssetFailure(reason)) void recoverLatestDeployment()
  })

  window.addEventListener('error', (event) => {
    if (isHashedAssetElement(event.target) || isDeploymentAssetFailure(event.message || event.error?.message)) {
      void recoverLatestDeployment()
    }
  }, true)
})()
