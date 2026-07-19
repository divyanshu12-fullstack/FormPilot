const API_BASE = 'http://127.0.0.1:8420';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'save_correction') {
    fetch(`${API_BASE}/corrections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        field_label: message.field_label,
        corrected_value: message.corrected_value
      })
    })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return res.json();
    })
    .then(data => {
      console.log('[FormPilot Service Worker] Correction saved:', data);
      sendResponse({ success: true, data });
    })
    .catch(err => {
      console.error('[FormPilot Service Worker] Failed to save correction:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
  return false;
});
