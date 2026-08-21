// Minimal offline app-shell cache. Never caches Firebase data — live trip
// data always comes from the network when online, and falls back to the
// localStorage copy (written in index.html on every sync) when it can't.
//
// v2: the dashboard's own HTML/manifest are now NETWORK-FIRST, not
// cache-first. v1 served a stale cached copy of index.html on every load
// and only refreshed the cache in the background for *next* time — which
// meant every code deploy needed an extra silent reload cycle before it
// actually showed up on a phone that had visited before. That's a real bug
// (see DEV_NOTES.md), not just a rare edge case, since this app gets
// updated in place fairly often. Only genuinely static assets (the icon)
// stay cache-first, since those don't change.
//
// v3: the shared engine got extracted into app.js (see DEV_NOTES.md
// History), and this file was never updated for it — same-origin .js
// requests fell through to the cache-first branch below, which meant a
// deployed fix to app.js (now where 100% of the dashboard's logic lives)
// could silently fail to show up on a returning visitor's phone until a
// second load, reproducing the exact v1 bug one level down. .js files are
// now network-first too, same rule as HTML/manifest. Cache name bumped
// again so any already-stale cached app.js gets purged on activate rather
// than lingering until it happens to get refetched.
const CACHE = 'trip-dashboard-shell-v3';

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll([
      '/trip-dashboard/icon.svg',
    ]).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const isAppShellDoc = req.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('manifest.json')
    || url.pathname.endsWith('.js');

  if (isAppShellDoc) {
    // Network-first: always try to get the latest code/manifest when
    // online. Only fall back to whatever's cached if the network request
    // fails outright (offline, DNS down, etc.) — matching the "offline
    // resilience" feature's actual intent. Covers app.js (see v3 note
    // above) as well as the HTML/manifest this already applied to.
    event.respondWith(
      fetch(req).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(req, response.clone()));
        return response;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Static assets (icon, etc.) — cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(req, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
