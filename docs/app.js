(function () {
  const slots = {
    mac: {
      // Both Mac downloads share one card, so toggle the individual rows.
      card: 'option-mac',
      btn: 'btn-mac',
      meta: 'meta-mac',
      url: 'url-mac',
      file: 'SimBox-mac.pkg',
      label: 'Mac',
    },
    macDmg: {
      card: 'option-mac-dmg',
      btn: 'btn-mac-dmg',
      meta: 'meta-mac-dmg',
      file: 'SimBox-mac.dmg',
      label: 'Mac (manual)',
      optional: true,
    },
    macIntel: {
      card: 'card-mac-intel',
      btn: 'btn-mac-intel',
      meta: 'meta-mac-intel',
      file: 'SimBox-mac-intel.dmg',
      label: 'Mac (Intel)',
      optional: true,
    },
    windows: {
      card: 'card-windows',
      btn: 'btn-windows',
      meta: 'meta-windows',
      url: 'url-windows',
      file: 'SimBox-windows.exe',
      label: 'Windows',
    },
    linux: {
      card: 'card-linux',
      btn: 'btn-linux',
      meta: 'meta-linux',
      file: 'SimBox-linux.AppImage',
      label: 'Linux',
      optional: true,
    },
  };

  function formatBytes(n) {
    if (!n || n <= 0) return '';
    const mb = n / (1024 * 1024);
    if (mb >= 100) return `${Math.round(mb)} MB`;
    return `${mb.toFixed(1)} MB`;
  }

  function absoluteFileUrl(file) {
    try {
      return new URL(`./files/${file}`, window.location.href).href;
    } catch (_err) {
      return `./files/${file}`;
    }
  }

  function applyManifest(manifest) {
    const versionEl = document.getElementById('version-line');
    const version = manifest.version || '1.0.0';
    const updated = manifest.updatedAt
      ? new Date(manifest.updatedAt).toLocaleString()
      : null;
    versionEl.textContent = updated
      ? `Version ${version} · updated ${updated}`
      : `Version ${version}`;

    const files = manifest.files || {};
    const base = (manifest.downloadBase || '').replace(/\/$/, '');

    Object.keys(slots).forEach((key) => {
      const slot = slots[key];
      const card = document.getElementById(slot.card);
      const btn = document.getElementById(slot.btn);
      const meta = document.getElementById(slot.meta);
      const info = files[key];

      if (slot.url) {
        const urlEl = document.getElementById(slot.url);
        if (urlEl) {
          urlEl.textContent = base
            ? `${base}/${slot.file}`
            : absoluteFileUrl(slot.file);
        }
      }

      if (slot.optional && card) {
        card.hidden = !info;
      }

      if (!info) {
        if (!slot.optional && card) {
          card.classList.add('unavailable');
          if (btn) {
            btn.classList.add('disabled');
            btn.removeAttribute('href');
            btn.textContent = `${slot.label} — coming soon`;
          }
          if (meta) meta.textContent = 'Not published yet. Rebuild and run npm run publish:downloads.';
        }
        return;
      }

      if (card) card.classList.remove('unavailable');
      if (btn) {
        btn.classList.remove('disabled');
        const href = base ? `${base}/${slot.file}` : `./files/${slot.file}`;
        btn.setAttribute('href', href);
        btn.setAttribute('download', slot.file);
      }
      if (meta) {
        const bits = [];
        if (info.size) bits.push(formatBytes(info.size));
        if (info.source) bits.push(info.source);
        meta.textContent = bits.join(' · ');
      }
    });
  }

  fetch('./latest.json', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((manifest) => {
      if (manifest) applyManifest(manifest);
      else applyManifest({ version: '1.0.0', files: {} });
    })
    .catch(() => applyManifest({ version: '1.0.0', files: {} }));
})();
