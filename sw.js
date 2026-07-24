const CACHE_NAME = 'heremay-smart-campus-v2.4.2';
const CORE_FILES = [
  './',
  './index.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_FILES))
      .catch(error => console.warn('核心快取建立失敗', error))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(names =>
        Promise.all(
          names
            .filter(name => name !== CACHE_NAME)
            .map(name => caches.delete(name))
        )
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data === 'CLEAR_CACHES' || event.data?.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then(names =>
        Promise.all(names.map(name => caches.delete(name)))
      )
    );
  }
});

function isFreshFirstRequest(request) {
  const url = new URL(request.url);

  if (request.mode === 'navigate') return true;

  return /\.(?:html?|js|css|json|webmanifest)$/i.test(url.pathname);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });

    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }

    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;

    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }

    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (isFreshFirstRequest(event.request)) {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});
