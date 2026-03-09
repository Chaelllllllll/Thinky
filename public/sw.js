// Thinky Service Worker — handles push notifications and basic caching
const CACHE_NAME = 'thinky-v1';
const STATIC_ASSETS = [
  '/',
  '/dashboard.html',
  '/index.html',
  '/css/style.css',
  '/images/icon-192.png',
  '/images/icon-512.png',
];

// ── Install: pre-cache static shells ──────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for static assets ───────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin http(s) GET requests
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (!url.protocol.startsWith('http')) return;

  // Skip API requests — always go to network
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Cache successful same-origin HTML/CSS/JS/image responses
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push: show rich notification ──────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Thinky', body: event.data ? event.data.text() : 'You have a new notification.' };
  }

  const title = payload.title || 'Thinky';
  const options = {
    body: payload.body || 'You have a new notification.',
    icon: '/images/icon-192.png',
    badge: '/images/icon-192.png',
    tag: payload.tag || payload.type || 'thinky-notif',
    renotify: true,
    data: {
      url: payload.url || payload.link || '/dashboard.html',
      type: payload.type || 'general',
    },
    actions: buildActions(payload.type),
    vibrate: [120, 60, 120],
    timestamp: Date.now(),
  };

  // Add a relevant image thumbnail when available
  if (payload.image) options.image = payload.image;

  event.waitUntil(self.registration.showNotification(title, options));
});

function buildActions(type) {
  switch (type) {
    case 'follow':
      return [{ action: 'view_profile', title: 'View Profile' }];
    case 'reaction':
    case 'comment':
    case 'reply':
    case 'new_reviewer':
      return [{ action: 'view', title: 'View' }, { action: 'dismiss', title: 'Dismiss' }];
    case 'message':
    case 'private_message':
      return [{ action: 'reply', title: 'Open Chat' }, { action: 'dismiss', title: 'Dismiss' }];
    default:
      return [{ action: 'view', title: 'Open' }];
  }
}

// ── Notification click: navigate to the right page ───────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action = event.action;
  const data = event.notification.data || {};
  const targetUrl = data.url || '/dashboard.html';

  if (action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing window/tab if already open and same origin
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          const target = new URL(targetUrl, self.location.origin);
          if (clientUrl.origin === target.origin) {
            client.focus();
            client.navigate(targetUrl);
            return;
          }
        } catch {}
      }
      // Otherwise open a new window
      return clients.openWindow(targetUrl);
    })
  );
});

// ── Push subscription change ──────────────────────────────────────────────────
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true })
      .then((sub) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub),
          credentials: 'include',
        })
      )
  );
});
