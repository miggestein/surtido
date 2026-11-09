// Guarda la app en el teléfono para que funcione sin internet.
const CACHE = 'surtido-bw-v1';
const ARCHIVOS = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Primero la red (para recibir actualizaciones); si no hay internet, lo guardado.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    const copia = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copia));
    return r;
  }).catch(() => caches.match(e.request)));
});
