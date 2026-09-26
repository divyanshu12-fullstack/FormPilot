// FormPilot Background Service Worker
importScripts('shared/config.js');

// Helper for fetch with timeout
async function fetchWithTimeout(urlPath, options = {}, timeoutMs = 10000) {
  const apiBase = await getApiBase();
  const url = `${apiBase}${urlPath}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  }
}

// Per-tab state. A service worker can be torn down at any time, so this is
// best-effort UI bookkeeping only — never a source of truth.
const frameCounts = new Map();
const frameReports = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'save_correction') {
    fetchWithTimeout('/corrections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field_label: message.field_label,
        corrected_value: message.corrected_value
      })
    }, 5000)
    .then(data => {
      sendResponse({ success: true, data });
    })
    .catch(err => {
      console.error('[FormPilot Service Worker] Failed to save correction:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
  
  if (message.action === 'match_fields') {
    // Option-aware payload: each entry carries its control kind and the option
    // texts, so the LLM can pick an exact option instead of only a data key.
    const payload = Array.isArray(message.unmatched_fields)
      ? { fields: message.unmatched_fields }
      : { unmatched_labels: message.unmatched_labels || [] };

    fetchWithTimeout('/match-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 30000)
    .then(data => {
      sendResponse({ success: true, mappings: data.mappings });
    })
    .catch(err => {
      console.error('[FormPilot Service Worker] Failed to match fields:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'draft_answer') {
    fetchWithTimeout('/draft-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: message.questions,
        user_context: message.user_context,
        use_profile: message.use_profile
      })
    }, 30000)
    .then(data => {
      sendResponse({ success: true, drafts: data.drafts });
    })
    .catch(err => {
      console.error('[FormPilot Service Worker] Failed to draft answer:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'forms_detected') {
    // Frames all report in; keep the badge on the highest count seen per tab.
    if (sender.tab) {
      if (typeof message.count === 'number') {
        frameCounts.set(`${sender.tab.id}`, Math.max(frameCounts.get(sender.tab.id) || 0, message.count));
      }
      if (message.count > 0) {
        fetchWithTimeout('/ping', {}, 2000)
          .then(() => {
            chrome.action.setBadgeText({ text: 'AI', tabId: sender.tab.id });
            chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab.id });
          })
          .catch(() => {
            chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
          });
      } else {
        chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'autofill_done') {
    // Aggregate per-frame reports so the badge reflects the whole tab.
    if (sender.tab) {
      const key = `${sender.tab.id}`;
      const agg = frameReports.get(key) || { filled: 0, needsReview: 0, frames: 0 };
      agg.filled += (message.report && message.report.filled) || 0;
      agg.needsReview += (message.report && message.report.needsReview) || 0;
      agg.frames++;
      frameReports.set(key, agg);
    }
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// --- Icon Click Handling ---
let clickCount = 0;
let clickTimer = null;

chrome.action.onClicked.addListener((tab) => {
  clickCount++;
  
  // Clear any existing timer on each new click
  if (clickTimer) {
    clearTimeout(clickTimer);
  }
  
  clickTimer = setTimeout(() => {
    const clicks = clickCount;
    clickCount = 0;
    clickTimer = null;
    
    if (clicks >= 2) {
      // Double or multi-click
      chrome.runtime.openOptionsPage();
    } else {
      // Single click — fetch profile, corrections, and resume concurrently
      frameReports.delete(tab.id);
      Promise.all([
        fetchWithTimeout('/profile', {}, 5000),
        fetchWithTimeout('/corrections', {}, 5000).catch(() => ({})),
        fetchWithTimeout('/resume', {}, 5000).catch(() => ({}))
      ])
        .then(([profile, corrections, resume]) => {
          // No frameId → delivered to every frame in the tab, so forms inside
          // same-origin iframes get filled too.
          chrome.tabs.sendMessage(tab.id, { action: 'autofill', profile: profile, corrections: corrections, resume: resume })
            .catch(err => console.log('Could not send autofill to tab:', err));
        })
        .catch(err => {
           console.error('Failed to fetch data for autofill:', err);
           chrome.tabs.sendMessage(tab.id, { action: 'autofill_error', error: 'Could not fetch profile. Is the backend running?' })
             .catch(() => {});
        });
    }
  }, 300);
});
