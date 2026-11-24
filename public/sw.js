const cacheName = 'my-mail-shell-v3'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.add('./')))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return

  if (event.request.mode === 'navigate') {
    // The host lets the browser reuse the page for ten minutes; asking it to check keeps a new deploy from hiding behind that.
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((response) => {
          const copy = response.clone()
          caches.open(cacheName).then((cache) => cache.put('./', copy))
          return response
        })
        .catch(() => caches.match('./')),
    )
    return
  }

  // Only the hashed build files are safe to serve from the cache without asking. The manifest and
  // icons keep their names across builds, so a cached copy would pin the old ones on the phone.
  if (!new URL(event.request.url).pathname.includes('/assets/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(cacheName).then((cache) => cache.put(event.request, copy))
          }
          return response
        })
        .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error())),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(cacheName).then((cache) => cache.put(event.request, copy))
      }
      return response
    })),
  )
})
