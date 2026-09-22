(function () {
  function apiUrl(path) {
    if (typeof window.simboxUrl === 'function') {
      return window.simboxUrl(path.replace(/^\//, ''));
    }
    return path.startsWith('/') ? path : `/${path}`;
  }

  function whenDesktop(timeoutMs) {
    if (window.simboxDesktop) return Promise.resolve(window.simboxDesktop);
    if (!window.SIMBOX_IS_PWA) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(window.simboxDesktop || null), timeoutMs || 8000);
      window.addEventListener(
        'simbox-desktop-ready',
        () => {
          clearTimeout(timer);
          resolve(window.simboxDesktop || null);
        },
        { once: true }
      );
    });
  }

  whenDesktop().then((desktop) => {
    startLibrary(desktop);
  });

  function startLibrary(desktop) {
    const grid = document.getElementById('library-grid');
    const statusEl = document.getElementById('library-status');
    const countEl = document.getElementById('case-count');
    const searchEl = document.getElementById('search');
    const emptyEl = document.getElementById('empty');
    const tabs = Array.from(document.querySelectorAll('.section-tab'));
    const offlineEl = document.getElementById('library-offline');
    const offlineTextEl = document.getElementById('library-offline-text');
    const offlineDetailEl = document.getElementById('library-offline-detail');
    const retryBtn = document.getElementById('retry-btn');
    const autoCheckEl = document.getElementById('auto-check');
    const checkNowBtn = document.getElementById('check-now-btn');
    const lastCheckedEl = document.getElementById('last-checked');
    const banner = document.getElementById('update-banner');
    const bannerTitle = document.getElementById('update-title');
    const bannerText = document.getElementById('update-text');
    const updateAllBtn = document.getElementById('update-all-btn');

    /** id -> { entry, el, refs } so progress can update one card in place. */
    const cards = new Map();
    let entries = [];
    let section = 'ed';

    function setStatus(message, state) {
      statusEl.textContent = message || '';
      if (state) statusEl.dataset.state = state;
      else delete statusEl.dataset.state;
    }

    function formatSize(bytes) {
      if (!bytes) return '';
      const mb = bytes / (1024 * 1024);
      if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
      return `${Math.round(mb)} MB`;
    }

    function formatWhen(iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
      } catch (_err) {
        return '';
      }
    }

    function plural(count, word) {
      return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function caseHref(id) {
      // Must live under /cases/<id>/ so Storyline relative urls (story_content/…) resolve.
      return apiUrl(`cases/${encodeURIComponent(id)}/`);
    }

    function buildCard(entry) {
      const el = document.createElement('article');
      el.className = 'lib-card';
      el.dataset.id = entry.id;

      const head = document.createElement('div');
      head.className = 'lib-card-head';

      const name = document.createElement('h2');
      name.className = 'lib-name';
      name.textContent = entry.name;
      head.appendChild(name);

      const badge = document.createElement('span');
      badge.className = 'lib-badge';
      head.appendChild(badge);
      el.appendChild(head);

      if (entry.title && entry.title !== entry.name) {
        const subtitle = document.createElement('p');
        subtitle.className = 'lib-subtitle';
        subtitle.textContent = entry.title;
        el.appendChild(subtitle);
      }

      if (entry.objectives && entry.objectives.length) {
        const list = document.createElement('ul');
        list.className = 'lib-objectives';
        entry.objectives.slice(0, 2).forEach((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          list.appendChild(li);
        });
        el.appendChild(list);
      }

      const foot = document.createElement('div');
      foot.className = 'lib-foot';

      const meta = document.createElement('span');
      meta.className = 'lib-size';
      const revised = entry.revised || entry.posted;
      meta.textContent = revised
        ? `${formatSize(entry.size)} · ${revised}`
        : formatSize(entry.size);
      foot.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';
      foot.appendChild(actions);
      el.appendChild(foot);

      const progress = document.createElement('div');
      progress.className = 'lib-progress';
      progress.hidden = true;
      const bar = document.createElement('div');
      bar.className = 'lib-bar';
      const fill = document.createElement('span');
      bar.appendChild(fill);
      const progressText = document.createElement('p');
      progressText.className = 'lib-progress-text';
      progress.appendChild(bar);
      progress.appendChild(progressText);
      el.appendChild(progress);

      cards.set(entry.id, {
        entry,
        el,
        refs: { badge, actions, progress, fill, progressText },
      });
      paintCard(entry.id);
      return el;
    }

    function paintCard(id) {
      const card = cards.get(id);
      if (!card) return;
      const { entry, el, refs } = card;

      el.classList.toggle('is-installed', !!entry.installed);
      refs.actions.textContent = '';

      refs.badge.classList.toggle('is-update', entry.status === 'update');
      if (entry.status === 'update') {
        refs.badge.hidden = false;
        refs.badge.textContent = 'Update ready';
      } else if (entry.installed) {
        refs.badge.hidden = false;
        refs.badge.textContent = 'Installed';
      } else {
        refs.badge.hidden = true;
      }

      if (entry.busy) {
        refs.progress.hidden = false;
        return;
      }

      if (!entry.installed) {
        refs.progress.hidden = true;
        refs.actions.appendChild(
          actionButton('Download', 'btn-primary', () => installCase(id))
        );
        return;
      }

      refs.progress.hidden = true;

      if (entry.status === 'update') {
        refs.actions.appendChild(
          actionButton('Update', 'btn-primary', () => installCase(id))
        );
        const open = document.createElement('a');
        open.className = 'btn-secondary';
        open.href = caseHref(entry.id);
        open.textContent = 'Open';
        refs.actions.appendChild(open);
        return;
      }

      const open = document.createElement('a');
      open.className = 'btn-primary';
      open.href = caseHref(entry.id);
      open.textContent = 'Open case';
      refs.actions.appendChild(open);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lib-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeCase(id));
      refs.actions.appendChild(remove);
    }

    function actionButton(label, className, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    }

    function render() {
      const query = (searchEl.value || '').trim().toLowerCase();
      const inSection = entries.filter((entry) => (entry.category || 'ed') === section);
      const visible = inSection.filter((entry) => {
        if (!query) return true;
        return (
          entry.name.toLowerCase().includes(query) ||
          (entry.title || '').toLowerCase().includes(query)
        );
      });

      grid.textContent = '';
      cards.clear();
      visible.forEach((entry) => grid.appendChild(buildCard(entry)));

      if (visible.length) {
        emptyEl.hidden = true;
      } else {
        emptyEl.hidden = false;
        emptyEl.textContent = inSection.length
          ? 'No cases match that search.'
          : section === 'ems'
            ? 'EMS cases are coming soon. When they are published they will appear here.'
            : 'No cases are available yet.';
      }

      const installed = inSection.filter((e) => e.installed).length;
      countEl.textContent = `${installed} of ${inSection.length} installed`;
      renderBanner();
    }

    function renderBanner() {
      const updates = entries.filter((e) => e.status === 'update');
      const fresh = entries.filter((e) => e.status === 'available');

      if (!updates.length && !fresh.length) {
        banner.hidden = true;
        return;
      }

      banner.hidden = false;
      const parts = [];
      if (updates.length) parts.push(`${plural(updates.length, 'case update')}`);
      if (fresh.length) parts.push(`${plural(fresh.length, 'new case')}`);
      bannerTitle.textContent = parts.join(' and ') + ' available';

      const names = [...updates, ...fresh].map((e) => e.name);
      bannerText.textContent =
        names.slice(0, 4).join(', ') + (names.length > 4 ? `, and ${names.length - 4} more` : '');

      updateAllBtn.hidden = updates.length === 0;
      updateAllBtn.textContent =
        updates.length > 1 ? `Update all ${updates.length}` : 'Update';
    }

    async function installCase(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry || entry.busy) return;

      entry.busy = true;
      paintCard(id);

      const card = cards.get(id);
      if (card) {
        card.refs.progressText.textContent = 'Starting download…';
        delete card.refs.progressText.dataset.state;
        card.refs.fill.style.width = '0%';
      }

      try {
        const result = await desktop.installCase(id);
        entry.busy = false;

        if (!result.ok) {
          paintCard(id);
          const failed = cards.get(id);
          if (failed) {
            failed.refs.progress.hidden = false;
            failed.refs.progressText.textContent = result.error || 'Download failed.';
            failed.refs.progressText.dataset.state = 'error';
          }
          setStatus(`${entry.name} could not be installed.`, 'error');
          return false;
        }

        entry.installed = true;
        entry.status = 'current';
        render();
        setStatus(`${entry.name} is installed and ready to run.`, 'ok');
        return true;
      } catch (err) {
        entry.busy = false;
        paintCard(id);
        setStatus(err.message || String(err), 'error');
        return false;
      }
    }

    async function removeCase(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;

      const result = await desktop.removeCase(id);
      if (!result.ok) {
        setStatus(result.error || 'Could not remove that case.', 'error');
        return;
      }
      entry.installed = false;
      entry.status = 'available';
      render();
      setStatus(`${entry.name} was removed from this computer.`);
    }

    function onProgress(payload) {
      const card = cards.get(payload.id);
      if (!card) return;

      card.refs.progress.hidden = false;
      delete card.refs.progressText.dataset.state;

      if (payload.phase === 'downloading') {
        const percent = payload.percent || 0;
        card.refs.fill.style.width = `${percent}%`;
        const received = formatSize(payload.received);
        const total = formatSize(payload.total);
        card.refs.progressText.textContent = total
          ? `Downloading… ${percent}% (${received} of ${total})`
          : `Downloading… ${received}`;
        return;
      }

      if (payload.phase === 'installing') {
        card.refs.fill.style.width = '100%';
        card.refs.progressText.textContent = 'Installing…';
        return;
      }

      if (payload.phase === 'done') {
        card.refs.fill.style.width = '100%';
        card.refs.progressText.textContent = 'Installed.';
        return;
      }

      if (payload.phase === 'error') {
        card.refs.progressText.textContent = payload.error || 'Download failed.';
        card.refs.progressText.dataset.state = 'error';
      }
    }

    function applySettings(settings) {
      if (!settings) return;
      autoCheckEl.checked = settings.autoCheckUpdates !== false;
      lastCheckedEl.textContent = settings.lastCheckedAt
        ? `Last checked ${formatWhen(settings.lastCheckedAt)}`
        : 'Not checked yet';
    }

    async function load(message) {
      if (message) setStatus(message);
      const result = await desktop.caseLibrary();

      if (!result.ok) {
        offlineEl.hidden = false;
        offlineTextEl.textContent = navigator.onLine
          ? 'SimBox could not download the case list. This is usually a temporary internet problem — wait a moment, then try again.'
          : 'This computer is not connected to the internet. Connect it, then try again.';
        offlineDetailEl.hidden = !result.error;
        offlineDetailEl.textContent = result.error || '';
        grid.textContent = '';
        cards.clear();
        emptyEl.hidden = true;
        countEl.textContent = '';
        banner.hidden = true;
        setStatus('');
        applySettings(await desktop.getSettings());
        return;
      }

      offlineEl.hidden = true;
      entries = result.cases.map((entry) => ({ ...entry, busy: false }));
      applySettings(result.settings);
      render();

      if (result.warning) setStatus(result.warning, 'warn');
      else if (!entries.some((e) => e.installed)) {
        setStatus('Choose a case below to download it.');
      } else setStatus('');
    }

    if (!desktop) {
      setStatus(
        'Open the SimBox desktop app to download cases. The browser version cannot install them.',
        'error'
      );
      [checkNowBtn, autoCheckEl, retryBtn].forEach((el) => {
        if (el) el.disabled = true;
      });
      return;
    }

    retryBtn.addEventListener('click', () => load('Looking for cases…'));

    desktop.onInstallProgress(onProgress);
    desktop.onUpdatesAvailable(() => load());

    searchEl.addEventListener('input', render);

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        section = tab.dataset.section;
        tabs.forEach((other) => {
          const active = other === tab;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        render();
      });
    });

    autoCheckEl.addEventListener('change', async () => {
      const settings = await desktop.setSettings({
        autoCheckUpdates: autoCheckEl.checked,
      });
      applySettings(settings);
      setStatus(
        autoCheckEl.checked
          ? 'SimBox will check for new and updated cases when it opens.'
          : 'Automatic checks are off. Use “Check now” when you want to look.'
      );
    });

    checkNowBtn.addEventListener('click', async () => {
      checkNowBtn.disabled = true;
      setStatus('Checking for new and updated cases…');
      try {
        const result = await desktop.checkUpdates();
        if (!result.ok) {
          setStatus(`Could not check for updates: ${result.error}`, 'error');
          return;
        }
        await load();
        const total = result.updates.length + result.newCases.length;
        if (!total) {
          setStatus('Everything is up to date.', 'ok');
        } else {
          setStatus(
            `Found ${plural(result.updates.length, 'update')} and ${plural(
              result.newCases.length,
              'new case'
            )}.`,
            'ok'
          );
        }
      } finally {
        checkNowBtn.disabled = false;
      }
    });

    updateAllBtn.addEventListener('click', async () => {
      updateAllBtn.disabled = true;
      const stale = entries.filter((e) => e.status === 'update').map((e) => e.id);
      for (const id of stale) {
        await installCase(id);
      }
      updateAllBtn.disabled = false;
      setStatus(`Updated ${plural(stale.length, 'case')}.`, 'ok');
    });

    load();
  }
})();
