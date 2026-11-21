// theme.js - Executed in <head> to prevent FOUC
(function() {
  function applyTheme(theme) {
    if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  // Read from browser-local extension storage in Firefox and Chromium browsers.
  if (globalThis.browser && globalThis.browser.storage) {
    globalThis.browser.storage.local.get({ theme: 'system' })
      .then(items => applyTheme(items.theme))
      .catch(() => applyTheme('system'));
  } else if (globalThis.chrome && globalThis.chrome.storage) {
    globalThis.chrome.storage.local.get({ theme: 'system' }, items => applyTheme(items.theme));
  } else {
    applyTheme('system');
  }
})();
