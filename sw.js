// Service Worker Elie — 20260504-01
// Stratégie : Network First (réseau prioritaire, cache en fallback offline)
const CACHE = 'elie-20260504-01';

self.addEventListener('install', e => {
  self.skipWaiting(); // prend le contrôle immédiatement
});

self.addEventListener('activate', e => {
  // Supprime tous les anciens caches
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim(); // prend le contrôle des onglets ouverts
});

// ── Push notifications ──────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: '✦ Elie', body: 'Nouveau message.' };
  try { data = e.data ? e.data.json() : data; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:      data.body,
      icon:      '/icon-192.png',   // PNG requis iOS
      badge:     '/icon-192.png',
      tag:       'elie-brief',
      renotify:  true,
      data:      { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const app = list.find(c => c.url.includes(self.location.origin));
      if (app) return app.focus();
      return clients.openWindow('/');
    })
  );
});

// ── Fetch (Network First) ───────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  // Les appels API ne sont jamais mis en cache
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network First : essaie le réseau, met à jour le cache, fallback cache si offline
  e.respondWith(
    fetch(e.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(e.request).then(cached => cached || Response.error())
      )
  );
});
