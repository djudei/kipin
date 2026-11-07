/**
 * KIPIN — service worker
 * Garde une copie de l'app pour qu'elle s'ouvre vite, même avec un mauvais réseau.
 * Réseau d'abord : une mise à jour publiée sur GitHub est prise dès qu'elle est disponible.
 * Les appels à Google et à Gemini ne passent jamais par le cache.
 */
const CACHE = 'kipin-v2';
const FICHIERS = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './js/app.js', './js/config.js', './js/google.js', './js/donnees.js', './js/gemini.js',
  './icons/icon-192.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(rep => {
        const copie = rep.clone();
        caches.open(CACHE).then(c => c.put(e.request, copie));
        return rep;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
