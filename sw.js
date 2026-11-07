/* Service worker : mise en cache de l'application pour un usage hors ligne.
 * Ne met JAMAIS en cache de donnée patient (aucune n'est jamais envoyée ni stockée). */
const VERSION = 'ordo-0.1.0';
const PRECACHE = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'js/engine.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'data/bdpm_light.json', 'data/connaissances_depart.csv', 'modele/Modele_plan_de_prise.docx',
  'vendor/pizzip.min.js', 'vendor/docxtemplater.min.js',
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js', 'vendor/tessdata/fra.traineddata',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  e.respondWith(
    caches.match(r, { ignoreSearch: true }).then((hit) => hit || fetch(r).then((res) => {
      if (res.ok) { const cp = res.clone(); caches.open(VERSION).then((c) => c.put(r, cp)); }
      return res;
    }).catch(() => (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
