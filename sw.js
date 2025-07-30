// sw.js - Service Worker file

// Listen for the 'push' event, which is triggered when a push message is received
self.addEventListener('push', function(event) {
    console.log('[Service Worker] Push Received.');
    console.log(`[Service Worker] Push had this data: "${event.data.text()}"`);

    const data = event.data.json(); // Assuming the payload is JSON
    const title = data.title || 'SRSI Mafia Notification';
    const options = {
        body: data.body || 'A new event has occurred in the game.',
        icon: data.icon || '/icon.png', // Optional: path to an icon for the notification
        badge: '/badge.png', // Optional: badge icon for mobile
        data: {
            url: data.data?.url || self.location.origin, // URL to open when notification is clicked
        }
    };

    // Show the notification
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// Listen for the 'notificationclick' event, which is triggered when the user clicks the notification
self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification click Received.');
    event.notification.close(); // Close the notification

    // Open the URL specified in the notification's data
    const urlToOpen = event.notification.data.url;
    event.waitUntil(
        clients.openWindow(urlToOpen)
    );
});

// Listen for the 'install' event to cache static assets (optional, but good practice for PWAs)
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing Service Worker...');
    // Skip waiting to activate immediately
    self.skipWaiting();
});

// Listen for the 'activate' event to clean up old caches (optional)
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating Service Worker...');
    event.waitUntil(clients.claim()); // Claim clients immediately
});