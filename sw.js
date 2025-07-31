// sw.js - Service Worker file

self.addEventListener('push', function(event) {
    const data = event.data.json();
    const title = data.title || 'SRSI Mafia Notification';
    const options = {
        body: data.body || 'A new event has occurred in the game.',
        icon: data.icon || '/icon.png', // Optional: path to an icon for the notification
        badge: '/badge.png', // Optional: badge icon for mobile
        data: {
            url: data.data?.url || self.location.origin, // URL to open when notification is clicked
        }
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();

    const urlToOpen = event.notification.data.url;
    event.waitUntil(
        clients.openWindow(urlToOpen)
    );
});

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});