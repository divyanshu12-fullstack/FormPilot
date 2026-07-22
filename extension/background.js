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
    fetchWithTimeout('/match-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unmatched_labels: message.unmatched_labels
      })
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

  return false;
});
