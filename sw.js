// sw.js - Service Worker file

self.addEventListener('push', function(event) {
    console.log('[Service Worker] Push Received.');
    // For Declarative Web Push, the browser might display the notification automatically.
    // This code provides a fallback for browsers that don't support Declarative Web Push
    // or if the declarative payload is invalid.

    if (event.data) {
        try {
            const data = event.data.json();
            // Check for the declarative magic key. If present, browser might handle it.
            // If not, or if we need custom logic, proceed with showNotification.
            if (data.web_push === 8030 && data.notification) {
                console.log('[Service Worker] Declarative Push detected. Browser might handle.');
                // We can still do optional work here if needed, like updating badge counts.
                // For now, we'll let the browser handle the display.
                // If you need to modify the notification before display, you'd use event.waitUntil
                // and show a new notification here. For basic declarative, no explicit showNotification needed.
            } else {
                console.log('[Service Worker] Standard Push detected. Showing notification imperatively.');
                const title = data.title || 'SRSI Mafia Notification';
                const options = {
                    body: data.body || 'A new event has occurred in the game.',
                    icon: data.icon || '/icon.png',
                    badge: '/badge.png',
                    data: {
                        url: data.data?.url || self.location.origin,
                    }
                };
                event.waitUntil(
                    self.registration.showNotification(title, options)
                );
            }
        } catch (e) {
            console.error('[Service Worker] Error parsing push data or non-JSON push:', e);
            // Fallback for non-JSON or malformed push messages
            const title = 'SRSI Mafia Update';
            const options = {
                body: event.data.text() || 'A new event has occurred in the game.',
                icon: '/icon.png',
                badge: '/badge.png',
                data: { url: self.location.origin }
            };
            event.waitUntil(
                self.registration.showNotification(title, options)
            );
        }
    } else {
        console.log('[Service Worker] Push received with no data payload.');
        // Handle silent pushes or pushes with no data
        event.waitUntil(
            self.registration.showNotification('SRSI Mafia Update', {
                body: 'Check the app for new information!',
                icon: '/icon.png',
                badge: '/badge.png',
                data: { url: self.location.origin }
            })
        );
    }
});

self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification click Received.');
    event.notification.close();

    const urlToOpen = event.notification.data?.url || self.location.origin;
    event.waitUntil(
        clients.openWindow(urlToOpen)
    );
});

self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing Service Worker...');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating Service Worker...');
    event.waitUntil(clients.claim());
});