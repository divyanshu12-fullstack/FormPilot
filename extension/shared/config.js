// FormPilot Centralized Configuration Module

const DEFAULT_CONFIG = {
  API_BASE: 'http://127.0.0.1:8420',
  HIGHLIGHT_DURATION: 3,
  AUTO_DRAFT_MODE: false
};

async function getApiBase() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ apiBase: DEFAULT_CONFIG.API_BASE }, (items) => {
        resolve(items.apiBase || DEFAULT_CONFIG.API_BASE);
      });
    } else {
      resolve(DEFAULT_CONFIG.API_BASE);
    }
  });
}

async function setApiBase(url) {
  return new Promise((resolve) => {
    const cleanUrl = (url || '').trim().replace(/\/+$/, '');
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ apiBase: cleanUrl }, () => resolve(cleanUrl));
    } else {
      resolve(cleanUrl);
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DEFAULT_CONFIG, getApiBase, setApiBase };
}
