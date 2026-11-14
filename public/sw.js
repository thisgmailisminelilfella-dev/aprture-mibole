const CACHE = 'aperture-shell-v6';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => { if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin || new URL(event.request.url).pathname.startsWith('/api/')) return; event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(result => result || caches.match('/index.html')))); });
