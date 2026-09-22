/* SimBox PWA service worker — offline shell + installed cases from Cache Storage */
const SHELL_CACHE = 'simbox-shell-v1';
const CASE_CACHE = 'simbox-cases-v1';

// Scope directory this SW was registered from, e.g. /simbox-app/play/ or /
const SCOPE = new URL('./', self.registration.scope).pathname;

function underScope(pathname) {
  return pathname.startsWith(SCOPE) ? pathname.slice(SCOPE.length) : null;
}

function contentType(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };
  return map[ext] || 'application/octet-stream';
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'simbox-cases-changed') {
    // No-op: cases are read from Cache Storage on each request.
  }
});

async function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('simbox-pwa', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key, fallback) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
    req.onerror = () => reject(req.error);
  });
}

function displayName(id) {
  return id
    .replace(/^SimBox_EMS_/i, '')
    .replace(/^SimBox_/i, '')
    .replace(/_/g, ' ')
    .trim();
}

async function apiCasesResponse() {
  const manifest = (await idbGet('installed', {})) || {};
  const cases = Object.keys(manifest)
    .map((id) => ({
      id,
      name: displayName(id),
      folder: id,
      category: /^SimBox_EMS_/i.test(id) ? 'ems' : 'ed',
      hasBridge: true,
      thumbnail: null,
          href: `${SCOPE}cases/${encodeURIComponent(id)}/`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return new Response(JSON.stringify(cases), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function healthResponse() {
  return new Response(JSON.stringify({ ok: true, pwa: true, activeSessions: 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function findCaseEntry(caseId) {
  const cache = await caches.open(CASE_CACHE);
  const candidates = [
    `cases/${caseId}/story.html`,
    `cases/${caseId}/index.html`,
    `cases/${caseId}/${caseId}/story.html`,
    `cases/${caseId}/${caseId}/index.html`,
  ];
  for (const rel of candidates) {
    const url = new URL(SCOPE + rel, self.location.origin).href;
    const hit = await cache.match(url);
    if (hit) return { url, rel, base: rel.replace(/[^/]+$/, '') };
  }
  return null;
}

function injectBridge(html, homeUrl) {
  const injection = `<script>window.SIMBOX_WS_SERVER="";window.SIMBOX_HOME_URL=${JSON.stringify(
    homeUrl
  )};window.SIMBOX_SHOW_MOBILE_UI=false;window.SIMBOX_PWA=true;</script>\n`;
  if (html.includes('window.SIMBOX_WS_SERVER')) return html;
  if (html.includes('simbox-bridge.js')) {
    return html.replace(
      /(<script[^>]*src=["'][^"']*simbox-bridge\.js["'][^>]*>\s*<\/script>)/i,
      `${injection}$1`
    );
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${injection}</body>`);
  }
  return injection + html;
}

async function serveCaseHtml(caseId) {
  const entry = await findCaseEntry(caseId);
  if (!entry) {
    return new Response('Case not installed on this device.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const cached = await caches.open(CASE_CACHE).then((c) => c.match(entry.url));
  let html = await cached.text();
  const homeUrl = new URL(SCOPE, self.location.origin).href;
  html = injectBridge(html, homeUrl);
  // If the playable file lives in a nested folder, rewrite so the browser URL
  // is /cases/<id>/nested/story.html … but we already serve at /cases/<id>/.
  // Prefer redirecting the client to the real entry URL when nested.
  if (entry.rel.includes(`/${caseId}/`) && entry.rel.split('/').length > 3) {
    return Response.redirect(new URL(SCOPE + entry.rel, self.location.origin).href, 302);
  }
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function serveCaseAsset(pathname) {
  const cache = await caches.open(CASE_CACHE);
  const url = new URL(pathname, self.location.origin).href;
  const hit = await cache.match(url);
  if (hit) return hit;

  // Try without double-encoding
  const alt = await cache.match(pathname);
  if (alt) return alt;

  return null;
}

async function shellFallback(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const path = new URL(request.url).pathname;
  const rel = underScope(path);
  if (rel === '' || rel === 'index.html' || rel === 'case/' || (rel && rel.startsWith('case/'))) {
    const index = await cache.match(new URL(SCOPE + 'index.html', self.location.origin).href);
    if (index) return index;
  }
  if (rel === 'library.html') {
    const lib = await cache.match(new URL(SCOPE + 'library.html', self.location.origin).href);
    if (lib) return lib;
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const rel = underScope(url.pathname);
  if (rel === null) return;

  // API shims
  if (rel === 'api/cases' || rel === 'api/cases/') {
    event.respondWith(apiCasesResponse());
    return;
  }
  if (rel === 'health' || rel === 'health/') {
    event.respondWith(healthResponse());
    return;
  }

  // /case/:id → redirect into the cases/ tree (relative assets need that base)
  const casePlay = rel.match(/^case\/([^/]+)\/?$/);
  if (casePlay) {
    const id = decodeURIComponent(casePlay[1]);
    event.respondWith(Response.redirect(new URL(`${SCOPE}cases/${encodeURIComponent(id)}/`, self.location.origin).href, 302));
    return;
  }

  // /cases/:id/ or /cases/:id → play installed case entry HTML
  const caseRoot = rel.match(/^cases\/([^/]+)\/?$/);
  if (caseRoot) {
    event.respondWith(serveCaseHtml(decodeURIComponent(caseRoot[1])));
    return;
  }

  // Case static assets
  if (rel.startsWith('cases/')) {
    event.respondWith(
      (async () => {
        const hit = await serveCaseAsset(url.pathname);
        if (hit) {
          // Inject bridge into HTML entry points
          const pathOnly = rel.split('?')[0];
          if (pathOnly.endsWith('.html') || pathOnly.endsWith('/')) {
            const parts = pathOnly.split('/').filter(Boolean);
            if (parts[1]) {
              const text = await hit.clone().text();
              if (text.includes('<html') || text.includes('<!DOCTYPE')) {
                const homeUrl = new URL(SCOPE, self.location.origin).href;
                return new Response(injectBridge(text, homeUrl), {
                  headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
              }
            }
          }
          return hit;
        }
        if (rel.endsWith('.html') || rel.endsWith('/')) {
          const parts = rel.split('/');
          if (parts[1]) {
            return serveCaseHtml(decodeURIComponent(parts[1]));
          }
        }
        return new Response('Not found', { status: 404 });
      })()
    );
    return;
  }

  // App shell: network-first, cache fallback (so updates land when online)
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(event.request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          const path = rel.split('?')[0];
          if (
            path.endsWith('.html') ||
            path.endsWith('.js') ||
            path.endsWith('.css') ||
            path.endsWith('.webmanifest') ||
            path.endsWith('.png') ||
            path.endsWith('.woff2') ||
            path === '' ||
            path === 'index.html'
          ) {
            cache.put(event.request, fresh.clone()).catch(() => {});
          }
        }
        return fresh;
      } catch (_err) {
        const cached = await shellFallback(event.request);
        if (cached) return cached;
        return new Response('SimBox is offline and this file is not cached yet.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});
