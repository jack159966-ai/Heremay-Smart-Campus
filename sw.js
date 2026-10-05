const CACHE_NAME = 'heremay-smart-campus-v2.5.0';
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

  // Dynamic APIs and external services must never reuse an old response.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) return;

  if (isFreshFirstRequest(event.request)) {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});

function campusNotificationUrl(value) {
  const fallback = new URL('./message_center.html', self.location.href);
  try {
    const url = new URL(value || fallback.href, fallback.href);
    if (url.origin === self.location.origin && url.pathname.startsWith('/Heremay-Smart-Campus/')) return url.href;
    if (url.origin === 'https://heremay-8t.myqnapcloud.com:9444' && ['/admin','/admin.html'].includes(url.pathname)) return url.href;
  } catch (_) {}
  return fallback.href;
}
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const submissionId = String(data.submissionId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const id = String(data.notificationId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const legacy = new URL('https://heremay-8t.myqnapcloud.com:9444/admin.html');
  if (submissionId) legacy.searchParams.set('submissionId', submissionId);
  const url = campusNotificationUrl(data.url || (submissionId ? legacy.href : ''));
  event.waitUntil(self.registration.showNotification(String(data.title || (submissionId ? '和美智慧校園｜新素材投稿' : '和美智慧校園｜新訊息')).slice(0,100), {
    body:String(data.body || '訊息中心有新資訊，點此查看。').slice(0,180),
    tag:id ? 'campus-'+id : submissionId ? 'media-'+submissionId : 'campus-message',
    renotify:false,
    ...(data.sound === false ? {silent:true} : {}),
    data:{url}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(campusNotificationUrl(event.notification.data?.url)));
});
