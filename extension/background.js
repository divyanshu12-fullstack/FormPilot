// FormPilot background handler. Firefox uses the scripts entry in the manifest;
// Chromium browsers use the service_worker entry. Keep this file classic-script
// compatible with both environments.
if (typeof FormPilotStore === 'undefined' && typeof importScripts === 'function') {
  importScripts('shared/storage.js');
}

const FormPilotAPI = globalThis.browser || globalThis.chrome;
const CONTENT_FILES = [
  'shared/constants.js',
  'shared/matching.js',
  'shared/widgets.js',
  'content_script.js'
];

async function hasContentScript(tabId) {
  try {
    const response = await FormPilotAPI.tabs.sendMessage(tabId, { action: 'ping' });
    return Boolean(response && response.formpilot);
  } catch (error) {
    return false;
  }
}

async function injectContentScript(tabId) {
  try {
    // allFrames reaches same-origin embedded forms. Cross-origin frames are
    // skipped because the extension holds no host permissions for them.
    await FormPilotAPI.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES
    });
    return;
  } catch (error) {
    // One blocked frame can fail the whole call; fall back to the top frame.
    if (await hasContentScript(tabId)) return;
  }
  await FormPilotAPI.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES
  });
}

async function messageTab(tabId, message) {
  try {
    return await FormPilotAPI.tabs.sendMessage(tabId, message);
  } catch (error) {
    // Content scripts are injected only after the user invokes FormPilot.
    await injectContentScript(tabId);
    return FormPilotAPI.tabs.sendMessage(tabId, message);
  }
}

async function setTabBadge(tabId, text) {
  try {
    await FormPilotAPI.action.setBadgeText({ tabId, text: String(text || '').slice(0, 4) });
  } catch (error) {
    // Badge support is a convenience; it must not affect filling.
  }
}

async function runAutofill(tab) {
  const [profile, allCorrections] = await Promise.all([
    FormPilotStore.loadProfile(),
    FormPilotStore.loadCorrections()
  ]);
  let domain = '';
  try { domain = new URL(tab.url || '').hostname.toLowerCase(); } catch (error) { /* unsupported page */ }
  const corrections = allCorrections.filter(item => item.domain === domain);

  const hasProfileValue = Object.values(profile).some(value => Array.isArray(value)
    ? value.length > 0
    : value !== null && value !== undefined && String(value).trim() !== '');
  if (!hasProfileValue) {
    await setTabBadge(tab.id, '');
    return { success: false, error: 'Add profile details before filling a form.' };
  }

  const result = await messageTab(tab.id, {
    action: 'autofill',
    profile,
    corrections
  });

  if (!result || !result.success) {
    await setTabBadge(tab.id, '!');
    return result || { success: false, error: 'FormPilot did not receive a fill report.' };
  }
  await setTabBadge(tab.id, result.report && result.report.filled ? result.report.filled : '');
  return result;
}

async function detectFields(tab) {
  const [profile, allCorrections] = await Promise.all([
    FormPilotStore.loadProfile(),
    FormPilotStore.loadCorrections()
  ]);
  let domain = '';
  try { domain = new URL(tab.url || '').hostname.toLowerCase(); } catch (error) { /* unsupported page */ }
  const corrections = allCorrections.filter(item => item.domain === domain);

  const result = await messageTab(tab.id, {
    action: 'detect',
    profile,
    corrections
  });
  return { success: true, ...(result || {}) };
}

function correctionDomain(sender) {
  try {
    const url = new URL(sender.url || '');
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase() : '';
  } catch (error) {
    return '';
  }
}

FormPilotAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== FormPilotAPI.runtime.id) return false;

  if (message.action === 'run_autofill') {
    FormPilotAPI.tabs.query({ active: true, currentWindow: true })
      .then(tabs => {
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== 'number') throw new Error('No active page is available.');
        return runAutofill(tab);
      })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'detect_fields') {
    FormPilotAPI.tabs.query({ active: true, currentWindow: true })
      .then(tabs => {
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== 'number') throw new Error('No active page is available.');
        return detectFields(tab);
      })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'save_correction') {
    const domain = correctionDomain(sender);
    const label = String(message.field_label || '').trim().slice(0, 200);
    const value = String(message.corrected_value || '').slice(0, 5000);
    if (!domain || !label || !value) {
      sendResponse({ success: false, error: 'Correction is incomplete.' });
      return false;
    }

    FormPilotStore.saveCorrection({
      domain: '',
      field_label: label,
      corrected_value: value,
      field_kind: message.field_kind
    }).then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});
