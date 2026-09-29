const shellCacheName = 'athlentry-app-shell-v1';
const shellAssetUrls = ['/', '/manifest.webmanifest', '/athlentry-icon.svg'].map(
  (path) => new URL(path, self.location.origin).href,
);
const shellUrl = new URL('/', self.location.origin).href;

function isLocalDevelopment() {
  return (
    self.location.hostname === 'localhost' ||
    self.location.hostname === '127.0.0.1' ||
    self.location.hostname === '[::1]' ||
    self.location.hostname.endsWith('.localhost')
  );
}

function isServerRenderedPath(pathname) {
  return ['/api', '/files', '/site', '/healthz'].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (!isLocalDevelopment()) {
        const cache = await caches.open(shellCacheName);
        await cache.addAll(shellAssetUrls);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (!isLocalDevelopment()) {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter(
              (name) =>
                name.startsWith('athlentry-app-shell-') &&
                name !== shellCacheName,
            )
            .map((name) => caches.delete(name)),
        );
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    isLocalDevelopment() ||
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    isServerRenderedPath(url.pathname)
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(shellCacheName);
        try {
          const response = await fetch(request);
          if (
            response.ok &&
            response.headers.get('content-type')?.includes('text/html')
          ) {
            await cache.put(shellUrl, response.clone());
          }
          return response;
        } catch {
          return (
            (await cache.match(shellUrl)) ??
            new Response('Athlentry is not available offline.', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          );
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(shellCacheName);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Athlentry', {
    body: 'You have a new update. Open Athlentry to view it.',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || '/'));
});
