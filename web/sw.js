// Service worker: shell z cache, API "síť nejdřív, při výpadku poslední data".
const SHELL = 'letackomat-shell-v4';
const DATA = 'letackomat-data-v1';
const ASSETS = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const hadOlderVersion = keys.some((k) => k.startsWith('letackomat-shell-') && k !== SHELL);
      await Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
      // aktualizace aplikace: otevřená okna ukazují starou verzi z cache, tak je jednou obnov
      if (hadOlderVersion) {
        const windows = await self.clients.matchAll({ type: 'window' });
        windows.forEach((w) => w.navigate(w.url).catch(() => {}));
      }
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // stav serveru se nesmí brát z cache, jinak by vypnutý server vypadal jako běžící
  if (url.origin === location.origin && url.pathname === '/api/health') return;

  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? new Response('{"error":"offline"}', { status: 503, headers: { 'content-type': 'application/json' } }))),
    );
    return;
  }

  // vlastní soubory aplikace: síť nejdřív (aby se po aktualizaci hned objevila nová verze), při výpadku cache
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/'))),
    );
    return;
  }

  // fonty a obrázky z jiných domén: cache s obnovou na pozadí
  e.respondWith(
    caches.match(request).then((hit) => {
      const net = fetch(request)
        .then((res) => {
          if (res.ok || res.type === 'opaque') {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? net;
    }),
  );
});
