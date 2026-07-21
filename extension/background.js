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
  
  if (message.action === 'match_fields') {
    fetch(`${API_BASE}/match-field`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        unmatched_labels: message.unmatched_labels
      })
    })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return res.json();
    })
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
    fetch(`${API_BASE}/draft-answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        questions: message.questions,
        user_context: message.user_context,
        use_profile: message.use_profile
      })
    })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return res.json();
    })
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
