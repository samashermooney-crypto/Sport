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
