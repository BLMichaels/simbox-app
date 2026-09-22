/**
 * Boots the Chromebook / browser PWA path when Electron is not present.
 * Must load before library.js / home.js.
 */
(function () {
  const script = document.currentScript;
  const base = script
    ? new URL('.', script.src).href
    : new URL('.', window.location.href).href;

  window.SIMBOX_BASE = base;
  window.SIMBOX_IS_PWA = !window.simboxDesktop;

  function abs(path) {
    return new URL(String(path).replace(/^\//, ''), base).href;
  }
  window.simboxUrl = abs;

  if (window.simboxDesktop) return;

  const boot = document.createElement('script');
  boot.src = abs('vendor/fflate.js');
  boot.onload = () => {
    const next = document.createElement('script');
    next.src = abs('browser-desktop.js');
    document.head.appendChild(next);
  };
  boot.onerror = () => {
    console.error('SimBox PWA: could not load unzip library');
  };
  document.head.appendChild(boot);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(abs('sw.js'), { scope: base }).catch((err) => {
        console.warn('SimBox PWA: service worker not registered', err);
      });
    });
  }
})();
