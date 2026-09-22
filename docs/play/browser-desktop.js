/**
 * Browser / Chromebook stand-in for window.simboxDesktop.
 * Downloads case ZIPs, stores files in Cache Storage, metadata in IndexedDB.
 * The service worker serves /cases/* and /api/cases from that cache offline.
 */
(function () {
  if (window.simboxDesktop) return;

  const BASE = window.SIMBOX_BASE || new URL('.', window.location.href).href;
  const CATALOG_URL =
    window.SIMBOX_CATALOG_URL ||
    'https://blmichaels.github.io/simbox-app/cases-catalog.json';
  const CASE_CACHE = 'simbox-cases-v1';
  const SHELL_CACHE = 'simbox-shell-v1';
  const DB_NAME = 'simbox-pwa';
  const DB_VERSION = 1;
  const DEFAULT_SETTINGS = { autoCheckUpdates: true, lastCheckedAt: null };

  const progressHandlers = new Set();
  const updateHandlers = new Set();
  const activeInstalls = new Set();

  function urlPath(path) {
    return new URL(String(path).replace(/^\//, ''), BASE).pathname;
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
      m3u8: 'application/vnd.apple.mpegurl',
      xml: 'application/xml',
    };
    return map[ext] || 'application/octet-stream';
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
    });
  }

  async function idbGet(key, fallback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get(key);
      req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(value, key);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await idbGet('settings', {})) };
  }

  async function setSettings(patch) {
    const next = { ...(await getSettings()), ...patch };
    await idbSet('settings', next);
    return next;
  }

  async function readManifest() {
    return (await idbGet('installed', {})) || {};
  }

  async function writeManifest(manifest) {
    await idbSet('installed', manifest);
  }

  async function sha256Hex(buffer) {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function loadCatalog() {
    try {
      const res = await fetch(CATALOG_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
      const catalog = await res.json();
      await idbSet('catalog', catalog);
      return { ok: true, catalog, source: 'network' };
    } catch (error) {
      const cached = await idbGet('catalog', null);
      if (cached) {
        return {
          ok: true,
          catalog: cached,
          source: 'cache',
          warning: `Showing the saved list — could not reach the case server (${error.message})`,
        };
      }
      return { ok: false, error: error.message || String(error) };
    }
  }

  function decorateWithStatus(catalog, installedIds, manifest) {
    return (catalog.cases || []).map((entry) => {
      const isInstalled = installedIds.includes(entry.id);
      const record = manifest[entry.id];
      let status = 'available';
      if (isInstalled) {
        if (!record || !record.sha256 || !entry.sha256) status = 'unknown';
        else if (record.sha256 !== entry.sha256) status = 'update';
        else status = 'current';
      }
      return {
        ...entry,
        installed: isInstalled,
        status,
        hasUpdate: status === 'update',
        installedAt: record ? record.installedAt : null,
      };
    });
  }

  async function installedCaseIds() {
    const manifest = await readManifest();
    return Object.keys(manifest);
  }

  function emitProgress(payload) {
    progressHandlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (_err) {
        /* ignore */
      }
    });
  }

  function emitUpdates(payload) {
    updateHandlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (_err) {
        /* ignore */
      }
    });
  }

  /**
   * Unzip into Cache Storage under /cases/<id>/...
   * Handles a single wrapper folder that is not a SimBox_* case.
   */
  async function extractZipToCache(caseId, zipBuffer, onFile) {
    if (!window.fflate || !window.fflate.unzipSync) {
      throw new Error('Unzip library is missing. Reload the page and try again.');
    }

    const files = window.fflate.unzipSync(new Uint8Array(zipBuffer));
    const names = Object.keys(files).filter((name) => !name.endsWith('/'));
    if (!names.length) throw new Error('The download contained no files.');

    // Strip a single non-case wrapper directory if present.
    let prefix = '';
    const top = new Set();
    names.forEach((name) => {
      const first = name.split('/')[0];
      if (first) top.add(first);
    });
    if (top.size === 1) {
      const only = [...top][0];
      if (!only.startsWith('SimBox_') && only !== 'EMS') {
        prefix = `${only}/`;
      }
    }

    const cache = await caches.open(CASE_CACHE);
    // Clear previous files for this case.
    const existing = await cache.keys();
    const casePrefix = urlPath(`cases/${caseId}/`);
    await Promise.all(
      existing
        .filter((req) => new URL(req.url).pathname.startsWith(casePrefix))
        .map((req) => cache.delete(req))
    );

    let written = 0;
    for (const name of names) {
      let rel = name;
      if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      if (!rel || rel.endsWith('/')) continue;

      // Files may live at SimBox_X/... or directly as story assets.
      let destRel = rel;
      if (!rel.startsWith(`${caseId}/`) && !rel.startsWith('EMS/')) {
        destRel = `${caseId}/${rel}`;
      }

      const bytes = files[name];
      const pathname = urlPath(`cases/${destRel}`);
      const requestUrl = new URL(pathname, BASE).href;
      const response = new Response(bytes, {
        headers: {
          'Content-Type': contentType(destRel),
          'Content-Length': String(bytes.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
      await cache.put(requestUrl, response);
      written += 1;
      if (onFile) onFile(written, names.length);
    }

    if (!written) throw new Error('No playable files were found inside the download.');

    // Remember which case paths exist for /api/cases.
    const index = (await idbGet('caseIndex', {})) || {};
    index[caseId] = {
      id: caseId,
      hasIndex: true,
      cachedAt: new Date().toISOString(),
    };
    await idbSet('caseIndex', index);

    return written;
  }

  async function removeCaseFiles(caseId) {
    const cache = await caches.open(CASE_CACHE);
    const casePrefix = urlPath(`cases/${caseId}/`);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((req) => new URL(req.url).pathname.startsWith(casePrefix))
        .map((req) => cache.delete(req))
    );
    const index = (await idbGet('caseIndex', {})) || {};
    delete index[caseId];
    await idbSet('caseIndex', index);
  }

  async function library() {
    const result = await loadCatalog();
    const installed = await installedCaseIds();
    const settings = await getSettings();

    if (!result.ok) {
      return { ok: false, error: result.error, installed, settings };
    }

    const cases = decorateWithStatus(result.catalog, installed, await readManifest());
    return {
      ok: true,
      source: result.source,
      warning: result.warning || null,
      version: result.catalog.version || null,
      settings,
      installed,
      installing: [...activeInstalls],
      updateCount: cases.filter((c) => c.hasUpdate).length,
      cases,
    };
  }

  async function checkUpdates() {
    const result = await loadCatalog();
    if (!result.ok) return { ok: false, error: result.error };

    const cases = decorateWithStatus(
      result.catalog,
      await installedCaseIds(),
      await readManifest()
    );
    const checkedAt = new Date().toISOString();
    await setSettings({ lastCheckedAt: checkedAt });

    const summary = {
      ok: true,
      checkedAt,
      offline: result.source === 'cache',
      newCases: cases.filter((c) => c.status === 'available'),
      updates: cases.filter((c) => c.status === 'update'),
      cases,
    };
    emitUpdates(summary);
    return summary;
  }

  async function updateSummary() {
    const result = await loadCatalog();
    if (!result.ok) return { updates: [], newCases: [] };
    const cases = decorateWithStatus(
      result.catalog,
      await installedCaseIds(),
      await readManifest()
    );
    return {
      updates: cases.filter((c) => c.status === 'update'),
      newCases: cases.filter((c) => c.status === 'available'),
    };
  }

  async function fetchCaseZip(url) {
    // GitHub release assets do not send CORS headers, so browser downloads need
    // a same-origin or allowlisted proxy. Prefer a configured proxy, then the
    // local Express /api/proxy-case when the PWA is served from the Node app.
    const proxies = [];
    if (window.SIMBOX_CASE_PROXY) proxies.push(window.SIMBOX_CASE_PROXY);
    try {
      const saved = localStorage.getItem('simboxCaseProxy');
      if (saved) proxies.push(saved);
    } catch (_err) {
      /* ignore */
    }
    // Bundled Cloudflare Worker (deploy workers/case-cors-proxy.js).
    proxies.push('https://simbox-case-proxy.jet-stop.workers.dev/?u=');
    proxies.push('https://simbox-case-proxy.blmichaels.workers.dev/?u=');
    proxies.push(new URL('api/proxy-case?u=', BASE).href);

    const attempts = [{ label: 'direct', href: url }];
    proxies.forEach((p) => {
      const href = p.includes('=') && p.endsWith('=')
        ? p + encodeURIComponent(url)
        : `${p}${p.includes('?') ? '&' : '?'}u=${encodeURIComponent(url)}`;
      attempts.push({ label: 'proxy', href });
    });

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt.href, { mode: 'cors', credentials: 'omit' });
        if (res.ok) return res;
        lastError = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Could not download the case.');
  }

  async function installCase(caseId) {
    if (!/^SimBox_[A-Za-z0-9_]+$/.test(caseId)) {
      return { ok: false, error: `Unexpected case id: ${caseId}` };
    }
    if (activeInstalls.has(caseId)) {
      return { ok: false, error: 'That case is already downloading.' };
    }

    const result = await loadCatalog();
    if (!result.ok) return { ok: false, error: result.error };

    const entry = (result.catalog.cases || []).find((item) => item.id === caseId);
    if (!entry) return { ok: false, error: `${caseId} is not in the case list.` };

    activeInstalls.add(caseId);
    try {
      try {
        if (navigator.storage && navigator.storage.persist) {
          await navigator.storage.persist();
        }
      } catch (_err) {
        /* optional */
      }

      emitProgress({
        id: caseId,
        phase: 'downloading',
        received: 0,
        total: entry.size || 0,
        percent: 0,
      });

      const response = await fetchCaseZip(entry.url);
      if (!response.ok) {
        throw new Error(`Download failed (HTTP ${response.status})`);
      }

      const total = Number(response.headers.get('content-length') || entry.size || 0);
      const reader = response.body && response.body.getReader();
      let received = 0;
      const chunks = [];

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          emitProgress({
            id: caseId,
            phase: 'downloading',
            received,
            total,
            percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
          });
        }
      } else {
        const buf = new Uint8Array(await response.arrayBuffer());
        chunks.push(buf);
        received = buf.length;
      }

      const zipBuffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        zipBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      const digest = await sha256Hex(zipBuffer.buffer);
      if (entry.sha256 && digest !== entry.sha256) {
        throw new Error('The download was incomplete or corrupted. Please try again.');
      }

      emitProgress({ id: caseId, phase: 'installing', percent: 100 });
      await extractZipToCache(caseId, zipBuffer.buffer);

      const manifest = await readManifest();
      manifest[caseId] = {
        sha256: digest,
        size: entry.size || received,
        revised: entry.revised || null,
        installedAt: new Date().toISOString(),
      };
      await writeManifest(manifest);

      // Tell the service worker to refresh its view of installed cases.
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'simbox-cases-changed',
          caseId,
        });
      }

      emitProgress({ id: caseId, phase: 'done', percent: 100 });
      return { ok: true, caseId };
    } catch (error) {
      emitProgress({
        id: caseId,
        phase: 'error',
        error: error.message || String(error),
      });
      return { ok: false, error: error.message || String(error) };
    } finally {
      activeInstalls.delete(caseId);
    }
  }

  async function removeCase(caseId) {
    try {
      await removeCaseFiles(caseId);
      const manifest = await readManifest();
      delete manifest[caseId];
      await writeManifest(manifest);
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'simbox-cases-changed',
          caseId,
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  /** Build the /api/cases payload from the install manifest for home.js. */
  async function listInstalledForApi() {
    const installed = await installedCaseIds();
    return installed
      .map((id) => {
        const name = id
          .replace(/^SimBox_EMS_/i, '')
          .replace(/^SimBox_/i, '')
          .replace(/_/g, ' ')
          .trim();
        const category = /^SimBox_EMS_/i.test(id) ? 'ems' : 'ed';
        return {
          id,
          name,
          folder: id,
          category,
          hasBridge: true,
          thumbnail: null,
          href: new URL(`cases/${encodeURIComponent(id)}/`, BASE).pathname,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Expose for the service worker via clients / messages if needed.
  window.__simboxPwa = { listInstalledForApi, CASE_CACHE, SHELL_CACHE, BASE };

  window.simboxDesktop = {
    isDesktop: true,
    isPwa: true,
    getPaths: async () => ({ isPackaged: true, isPwa: true }),
    caseCount: async () => (await installedCaseIds()).length,
    caseLibrary: library,
    installCase,
    removeCase,
    getSettings,
    setSettings,
    checkUpdates,
    updateSummary,
    onInstallProgress: (handler) => {
      progressHandlers.add(handler);
      return () => progressHandlers.delete(handler);
    },
    onUpdatesAvailable: (handler) => {
      updateHandlers.add(handler);
      return () => updateHandlers.delete(handler);
    },
  };

  window.dispatchEvent(new Event('simbox-desktop-ready'));

  // Warm the shell cache and auto-check updates (same spirit as Electron).
  (async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      const shell = [
        'index.html',
        'library.html',
        'home.css',
        'home.js',
        'library.css',
        'library.js',
        'pwa-boot.js',
        'browser-desktop.js',
        'sw.js',
        'manifest.webmanifest',
        'simbox-logo.png',
        'vendor/fflate.js',
        'fonts/fonts.css',
      ].map((p) => new URL(p, BASE).href);
      await cache.addAll(shell.map((u) => new Request(u, { cache: 'reload' })).filter(Boolean)).catch(
        () => cache.addAll(shell).catch(() => {})
      );
    } catch (_err) {
      /* first visit may be fine without a full shell cache */
    }

    const settings = await getSettings();
    if (settings.autoCheckUpdates !== false) {
      setTimeout(() => {
        checkUpdates().catch(() => {});
      }, 2000);
    }
  })();
})();
