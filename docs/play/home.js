// Set to true to show mobile pairing UI (server URL footer, bridge badges)
// Also enable with ?mobile=1 on the home page URL
const SHOW_MOBILE_UI =
  window.SIMBOX_SHOW_MOBILE_UI === true ||
  new URLSearchParams(window.location.search).get('mobile') === '1';

const SECTIONS = {
  ed: {
    id: 'ed',
    label: 'Emergency Department',
    empty: 'No Emergency Department cases found yet.',
  },
  ems: {
    id: 'ems',
    label: 'EMS',
    empty: 'EMS cases coming soon. We’ll add them here together.',
  },
};

const grid = document.getElementById('case-grid');
const empty = document.getElementById('empty');
const comingSoon = document.getElementById('coming-soon');
const search = document.getElementById('search');
const countEl = document.getElementById('case-count');
const statusEl = document.getElementById('server-status');
const wsUrlEl = document.getElementById('ws-url');
const mobileFooter = document.getElementById('mobile-footer');
const casePanel = document.getElementById('case-panel');
const tabs = [...document.querySelectorAll('.section-tab')];

let cases = [];
let activeSection = 'ed';

function hostWsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

if (SHOW_MOBILE_UI && mobileFooter && wsUrlEl) {
  mobileFooter.hidden = false;
  wsUrlEl.textContent = hostWsUrl();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function casesForActiveSection() {
  return cases.filter((c) => (c.category || 'ed') === activeSection);
}

function updateComingSoon(list) {
  if (!comingSoon) return;
  const showBanner = activeSection === 'ems' && list.length === 0 && !search.value.trim();
  comingSoon.hidden = !showBanner;
}

function render(list) {
  grid.innerHTML = '';
  const section = SECTIONS[activeSection];
  countEl.textContent = `${list.length} case${list.length === 1 ? '' : 's'}`;
  updateComingSoon(list);

  if (list.length === 0) {
    // EMS empty state uses the Coming Soon banner instead of plain empty text
    if (activeSection === 'ems' && !search.value.trim()) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    empty.textContent = search.value.trim()
      ? `No ${section.label} cases match your filter.`
      : section.empty;
    return;
  }

  empty.hidden = true;

  list.forEach((item, index) => {
    const link = document.createElement('a');
    link.className = 'case';
    link.href = item.href;
    link.setAttribute('role', 'listitem');
    link.style.animationDelay = `${0.05 + index * 0.04}s`;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.thumbnail) {
      thumb.style.backgroundImage = `linear-gradient(180deg, transparent 40%, rgba(11,18,24,0.55)), url("${item.thumbnail}")`;
    }

    const meta = document.createElement('div');
    meta.className = 'meta';

    let badgeHtml = '';
    if (SHOW_MOBILE_UI) {
      badgeHtml = `
        <span class="badge ${item.hasBridge ? 'ready' : ''}">
          ${item.hasBridge ? 'Mobile control ready' : 'Bridge not installed'}
        </span>
      `;
    }

    meta.innerHTML = `
      <h2>${escapeHtml(item.name)}</h2>
      ${badgeHtml}
    `;

    link.appendChild(thumb);
    link.appendChild(meta);
    grid.appendChild(link);
  });
}

function applyFilter() {
  const q = search.value.trim().toLowerCase();
  const sectionCases = casesForActiveSection();
  const filtered = !q
    ? sectionCases
    : sectionCases.filter((c) =>
        c.name.toLowerCase().includes(q) || c.folder.toLowerCase().includes(q)
      );
  render(filtered);
}

function setSection(sectionId) {
  if (!SECTIONS[sectionId]) return;
  activeSection = sectionId;

  tabs.forEach((tab) => {
    const isActive = tab.dataset.section === sectionId;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  if (casePanel) {
    casePanel.setAttribute('aria-labelledby', `tab-${sectionId}`);
  }

  const url = new URL(window.location.href);
  url.searchParams.set('section', sectionId);
  window.history.replaceState({}, '', url);

  applyFilter();
}

async function load() {
  try {
    const api = (path) =>
      typeof window.simboxUrl === 'function' ? window.simboxUrl(path) : `/${path}`;

    const [healthRes, casesRes] = await Promise.all([
      fetch(api('health')),
      fetch(api('api/cases')),
    ]);

    if (!healthRes.ok || !casesRes.ok) throw new Error('Server unavailable');

    const health = await healthRes.json();
    cases = await casesRes.json();

    if (SHOW_MOBILE_UI && health.activeSessions) {
      statusEl.textContent = `Online · ${health.activeSessions} active session${health.activeSessions === 1 ? '' : 's'}`;
    } else {
      statusEl.textContent = health.pwa ? 'Ready · Chromebook / web' : 'Online · ready';
    }
    statusEl.dataset.state = 'ok';

    const requested = new URLSearchParams(window.location.search).get('section');
    setSection(requested === 'ems' ? 'ems' : 'ed');
  } catch (error) {
    statusEl.textContent = 'Server offline';
    statusEl.dataset.state = 'error';
    empty.hidden = false;
    empty.textContent = window.SIMBOX_IS_PWA
      ? 'No cases installed yet. Open the case library to download one.'
      : 'Could not load cases. Is the SimBox server running?';
    countEl.textContent = '0 cases';
  }
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => setSection(tab.dataset.section));
});

search.addEventListener('input', applyFilter);

const casesManage = document.getElementById('cases-manage');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const updatesBanner = document.getElementById('updates-banner');
const updatesBannerTitle = document.getElementById('updates-banner-title');
const updatesBannerText = document.getElementById('updates-banner-text');

if (window.simboxDesktop && casesManage) {
  casesManage.hidden = false;
}

// PWA: desktop bridge may arrive a moment after boot.
if (!window.simboxDesktop && window.SIMBOX_IS_PWA && casesManage) {
  window.addEventListener(
    'simbox-desktop-ready',
    () => {
      casesManage.hidden = false;
      window.simboxDesktop.updateSummary().then(showUpdateSummary).catch(() => {});
      window.simboxDesktop.onUpdatesAvailable(showUpdateSummary);
    },
    { once: true }
  );
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Show what the background check found, linking through to the library. */
function showUpdateSummary(summary) {
  if (!updatesBanner || !summary) return;

  const updates = summary.updates || [];
  const fresh = summary.newCases || [];
  if (!updates.length && !fresh.length) {
    updatesBanner.hidden = true;
    return;
  }

  const parts = [];
  if (updates.length) parts.push(plural(updates.length, 'case update'));
  if (fresh.length) parts.push(plural(fresh.length, 'new case'));
  updatesBannerTitle.textContent = `${parts.join(' and ')} available`;

  const names = [...updates, ...fresh].map((item) => item.name);
  updatesBannerText.textContent =
    names.slice(0, 4).join(', ') +
    (names.length > 4 ? `, and ${names.length - 4} more` : '');

  updatesBanner.hidden = false;
}

if (window.simboxDesktop) {
  window.simboxDesktop.updateSummary().then(showUpdateSummary).catch(() => {});
  window.simboxDesktop.onUpdatesAvailable(showUpdateSummary);
}

if (window.simboxDesktop && checkUpdatesBtn) {
  checkUpdatesBtn.addEventListener('click', async () => {
    checkUpdatesBtn.disabled = true;
    const original = checkUpdatesBtn.textContent;
    checkUpdatesBtn.textContent = 'Checking…';
    try {
      const result = await window.simboxDesktop.checkUpdates();
      if (!result.ok) {
        checkUpdatesBtn.textContent = 'Check failed';
        return;
      }
      showUpdateSummary(result);
      if (!result.updates.length && !result.newCases.length) {
        checkUpdatesBtn.textContent = 'Up to date';
        setTimeout(() => {
          checkUpdatesBtn.textContent = original;
        }, 3000);
        return;
      }
      checkUpdatesBtn.textContent = original;
    } finally {
      checkUpdatesBtn.disabled = false;
    }
  });
}

load();
