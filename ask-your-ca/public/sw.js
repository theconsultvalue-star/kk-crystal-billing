// Makes Ask your CA installable and quick to open. Only the app's own files
// (styles, script, icons) are cached; questions, answers and notes always
// come live from the server, so the central database stays the one source.
const CACHE = 'askca-v1';
const SHELL = ['/style.css', '/app.js', '/icons/icon-192.png', '/icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const OFFLINE_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ask your CA</title><body style="font-family:system-ui;padding:40px 20px;text-align:center;color:#1c1e21">
<h2>You're offline</h2><p style="color:#6b7280">Ask your CA needs an internet connection. Reconnect and try again.</p>
<button onclick="location.reload()" style="background:#1f5f8b;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px">Retry</button>`;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    // Network first so updates show at once; cached copy when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
