const CACHE_NAME = 'healthflow-pharmacy-shell-v3'
const APP_SHELL = ['/', '/index.html', '/app-logo.png', '/manifest.webmanifest']

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

  if (request.method !== 'GET') {
    return
  }

  const requestUrl = new URL(request.url)
  if (requestUrl.origin !== self.location.origin) {
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
      const preferNetwork = ['script', 'style'].includes(request.destination)

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
            ['script', 'style', 'image', 'font', 'manifest'].includes(request.destination)

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
