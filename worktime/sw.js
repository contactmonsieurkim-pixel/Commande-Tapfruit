// Work Time service worker — 웹 푸시 알림만 처리 (페이지 캐시는 하지 않음)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { /* 빈 페이로드 */ }
  e.waitUntil(self.registration.showNotification(d.title || 'I have an unread announcement !', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'announcement',
    renotify: true,
    data: { url: d.url || './?view=ann' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || './?view=ann', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'navigate' in c) {
        return c.navigate(url).then((w) => (w || c).focus()).catch(() => self.clients.openWindow(url));
      }
    }
    return self.clients.openWindow(url);
  }));
});
