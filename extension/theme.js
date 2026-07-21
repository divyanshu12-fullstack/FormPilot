// theme.js - Executed in <head> to prevent FOUC
(function() {
  function applyTheme(theme) {
    if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  // Attempt to read from chrome.storage.local immediately
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ theme: 'system' }, (items) => {
      applyTheme(items.theme);
    });
  } else {
    applyTheme('system');
  }
})();
