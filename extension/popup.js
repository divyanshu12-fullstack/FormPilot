// ── FormPilot Popup Logic ──
// Handles UI state rendering and communication with content script / backend

const API_BASE = 'http://127.0.0.1:8420';

const statusBar  = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const actionZone = document.getElementById('actionZone');
const autofillBtn = document.getElementById('autofillBtn');
const logZone    = document.getElementById('logZone');
const logLine    = document.getElementById('logLine');
const settingsBtn = document.getElementById('settingsBtn');

// ── State rendering functions ──

function showFieldsDetected(count) {
  statusBar.className = 'status-bar';
  statusText.className = 'status-text';
  statusText.textContent = `${count} field${count !== 1 ? 's' : ''} detected`;
  actionZone.className = 'action-zone';
  autofillBtn.disabled = false;
  autofillBtn.className = 'btn-autofill';
  autofillBtn.textContent = 'Autofill this page';
}

function showNoFields() {
  statusBar.className = 'status-bar empty';
  statusText.className = 'status-text';
  statusText.textContent = 'No fillable fields on this page';
  actionZone.className = 'action-zone hidden';
  logZone.innerHTML = '<p class="log-nudge">Try opening a job application form.</p>';
}

function showLoading() {
  autofillBtn.disabled = true;
  autofillBtn.className = 'btn-autofill loading';
  autofillBtn.textContent = 'Working on it…';
  statusText.textContent = 'Filling…';
}

function showFillResult(matched, needsReview) {
  statusBar.className = 'status-bar';
  statusText.className = 'status-text';
  
  if (matched === 0) {
    statusText.textContent = 'Autofill complete';
  } else {
    statusText.textContent = `${matched} field${matched !== 1 ? 's' : ''} filled`;
  }
  
  autofillBtn.disabled = false;
  autofillBtn.className = 'btn-autofill';
  autofillBtn.textContent = 'Autofill this page';

  if (needsReview > 0) {
    logLine.textContent = `${matched} filled · ${needsReview} need${needsReview !== 1 ? '' : 's'} review`;
  } else {
    logLine.textContent = `${matched} field${matched !== 1 ? 's' : ''} filled`;
  }
  logLine.className = 'log-line';
}

function showBackendDown() {
  statusBar.className = 'status-bar error';
  statusText.className = 'status-text error';
  statusText.textContent = "Can't reach FormPilot server";
  actionZone.className = 'action-zone hidden';
  logZone.innerHTML = '<p class="log-line error">Is the backend running on port 8420?</p>';
}

function showError(message) {
  statusBar.className = 'status-bar error';
  statusText.className = 'status-text error';
  statusText.textContent = 'Something went wrong';
  autofillBtn.disabled = false;
  autofillBtn.className = 'btn-autofill';
  autofillBtn.textContent = 'Try again';
  logLine.className = 'log-line error';
  logLine.textContent = message || 'An unexpected error occurred.';
}

function showProfileIncomplete() {
  logZone.innerHTML = `<p class="log-nudge">Your profile is incomplete. <a id="openSettingsNudge" href="#">Open Settings</a> to add your info.</p>`;
  document.getElementById('openSettingsNudge').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ── Settings button ──
settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Autofill button ──
autofillBtn.addEventListener('click', async () => {
  showLoading();

  try {
    const res = await fetch(`${API_BASE}/profile`, { method: 'GET' });
    if (!res.ok) throw new Error('Failed to fetch profile');
    const profile = await res.json();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'autofill', profile }, (response) => {
      if (chrome.runtime.lastError) {
        showError('Could not connect to this page. Try refreshing.');
        return;
      }
      if (response && response.success) {
        showFillResult(response.matched || 0, response.needsReview || 0);
      } else if (response && response.error) {
        showError(response.error);
      } else {
        showError('No response from the page.');
      }
    });
  } catch (err) {
    showError('Could not connect to this page.');
  }
});

// ── On popup open: check backend health and scan for fields ──
async function init() {
  // 1. Check backend health
  try {
    const res = await fetch(`${API_BASE}/ping`, { method: 'GET' });
    if (!res.ok) throw new Error();
  } catch {
    showBackendDown();
    return;
  }

  // 2. Check profile completeness
  try {
    const res = await fetch(`${API_BASE}/profile`, { method: 'GET' });
    const profile = await res.json();
    const filled = Object.values(profile).filter(v => v !== null && v !== '').length;
    // id is always present, so subtract 1
    if (filled <= 1) {
      showNoFields();
      showProfileIncomplete();
      return;
    }
  } catch {
    // Non-critical — continue even if profile check fails
  }

  // 3. Ask content script for field count
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'scan' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        showNoFields();
        return;
      }
      if (response.fieldCount > 0) {
        showFieldsDetected(response.fieldCount);
      } else {
        showNoFields();
      }
    });
  } catch {
    showNoFields();
  }
}

init();
