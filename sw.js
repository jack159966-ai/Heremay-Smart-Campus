const APP_VERSION = '1.1.0';
const CACHE_NAME = `heremay-smart-campus-${APP_VERSION}`;
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './version.json',
  './assets/logo.png',
  './assets/app-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(CORE_ASSETS.map(asset => cache.add(asset)))
    )
  );
});

self.addEventListener('message', event => {
  if(event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if(request.method !== 'GET') return;

  const url = new URL(request.url);
  if(url.origin !== self.location.origin) return;

  if(request.mode === 'navigate' || url.pathname.endsWith('/version.json')){
    event.respondWith(
      fetch(request, {cache:'no-store'})
        .then(response => {
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request,copy));
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const network=fetch(request).then(response => {
        if(response.ok){
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request,copy));
        }
        return response;
      });
      return cached || network;
    })
  );
});
