/**
 * KIPIN — service worker
 * Garde une copie de l'app pour qu'elle s'ouvre vite, même avec un mauvais réseau.
 * Réseau d'abord : une mise à jour publiée sur GitHub est prise dès qu'elle est disponible.
 * Les appels à Google et à Gemini ne passent jamais par le cache.
 */
const CACHE = 'kipin-v21';
const FICHIERS = [
  './', './index.html', './css/styles.css', './manifest.webmanifest',
  './js/app.js', './js/import.js', './js/attente.js', './js/config.js', './js/google.js', './js/donnees.js', './js/gemini.js',
  './icons/icon-192.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' : on prend toujours la dernière version publiée, jamais une copie gardée par le navigateur.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
    // cache: 'no-cache' : le navigateur vérifie auprès de GitHub à chaque ouverture,
    // pour qu'une mise à jour soit visible tout de suite (et non 10 minutes plus tard).
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(rep => {
        const copie = rep.clone();
        caches.open(CACHE).then(c => c.put(e.request, copie));
        return rep;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
