const CACHE_NAME = 'healthflow-pharmacy-shell-v5'
const APP_SHELL = ['/', '/index.html', '/app-logo.png', '/manifest.webmanifest']
const isAppAssetRequest = (request) => {
  if (request.method !== 'GET') {
    return false
  }

  const requestUrl = new URL(request.url)
  if (requestUrl.origin !== self.location.origin) {
    return false
  }

  return !requestUrl.pathname.startsWith('/api/')
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (!isAppAssetRequest(request)) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseCopy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', responseCopy))
          return response
        })
        .catch(async () => {
          const cachedShell = await caches.match('/index.html')
          return cachedShell || new Response('HealthFlow is unavailable offline until the app shell is cached.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          })
        })
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const preferNetwork = ['document', 'script', 'style', 'worker'].includes(request.destination)

      if (preferNetwork) {
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const responseCopy = response.clone()
              caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy))
            }

            return response
          })
          .catch(() => cachedResponse || Response.error())
      }

      if (cachedResponse) {
        return cachedResponse
      }

      return fetch(request)
        .then((response) => {
          const cacheable =
            response.ok &&
            ['script', 'style', 'image', 'font', 'manifest', 'worker', ''].includes(request.destination)

          if (cacheable) {
            const responseCopy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, responseCopy))
          }

          return response
        })
        .catch(() => cachedResponse || Response.error())
    })
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'HEALTHFLOW_SKIP_WAITING') {
    self.skipWaiting()
    return
  }

  if (event.data?.type === 'HEALTHFLOW_CLEAR_APP_CACHES') {
    event.waitUntil(
      caches
        .keys()
        .then((cacheNames) => Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName))))
    )
    return
  }

  if (event.data?.type !== 'HEALTHFLOW_PRECACHE_URLS') {
    return
  }

  const urls = Array.isArray(event.data.urls) ? event.data.urls : []
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        urls
          .filter((url) => typeof url === 'string' && url.startsWith('/'))
          .map((url) => cache.add(url))
      )
    )
  )
})
