const CACHE_NAME = 'siberdeyz-pwa-20260923-auto-cleanup-1';

const APP_SHELL = [
  '/desktopLayout.css',
  '/desktopLayout.js',
  '/accountHealthRefresh.js',
  '/',
  '/index.html',
  '/styles.css',
  '/settingsLayout.css',
  '/webScan.css',
  '/fullSiteScan.css',
  '/channelLoadFeedback.css',
  '/playerTimelinePro.css',
  '/activeAccountHeader.css',
  '/bottomDock.css',
  '/auroraDock.js',
  '/app.js',
  '/appSettings.js',
  '/userAccessSettings.js',
  '/webScan.js',
  '/fullSiteScan.js',
  '/playerTimeline.js',
  '/channelLoadFeedback.js',
  '/accountMultiConnection.js',
  '/manifest.webmanifest',
  '/offline.html',
  '/favicon.svg',
  '/icons/icon.svg',
  '/icons/mask-icon.svg',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

const NETWORK_FIRST_ASSETS = new Set([
  '/desktopLayout.css',
  '/desktopLayout.js',
  '/accountHealthRefresh.js',
  '/',
  '/index.html',
  '/styles.css',
  '/settingsLayout.css',
  '/webScan.css',
  '/fullSiteScan.css',
  '/bottomDock.css',
  '/auroraDock.js',
  '/app.js',
  '/appSettings.js',
  '/userAccessSettings.js',
  '/webScan.js',
  '/fullSiteScan.js',
  '/manifest.webmanifest',
  '/offline.html',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/offline.html')))
    );
    return;
  }

  const isAppAsset = APP_SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/');
  if (!isAppAsset) return;

  if (NETWORK_FIRST_ASSETS.has(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/offline.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
