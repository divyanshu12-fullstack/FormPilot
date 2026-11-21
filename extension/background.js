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

async function injectContentScript(tabId) {
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
  const [profile, allCorrections, preferences] = await Promise.all([
    FormPilotStore.loadProfile(),
    FormPilotStore.loadCorrections(),
    FormPilotStore.loadPreferences()
  ]);
  let domain = '';
  try { domain = new URL(tab.url || '').hostname.toLowerCase(); } catch (error) { /* unsupported page */ }
  const corrections = allCorrections.filter(item => item.domain === domain);

  const result = await messageTab(tab.id, {
    action: 'autofill',
    profile,
    corrections,
    preferences
  });

  if (!result || !result.success) {
    await setTabBadge(tab.id, '!');
    return;
  }
  await setTabBadge(tab.id, result.report && result.report.filled ? result.report.filled : '');
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

  if (message.action === 'save_correction') {
    const domain = correctionDomain(sender);
    const label = String(message.field_label || '').trim().slice(0, 200);
    const value = String(message.corrected_value || '').slice(0, 5000);
    if (!domain || !label || !value) {
      sendResponse({ success: false, error: 'Correction is incomplete.' });
      return false;
    }

    FormPilotStore.saveCorrection({
      domain,
      field_label: label,
      corrected_value: value,
      field_kind: message.field_kind
    }).then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});

FormPilotAPI.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  runAutofill(tab).catch(async (error) => {
    console.error('[FormPilot] Autofill could not start:', error.message);
    await setTabBadge(tab.id, '!');
  });
});
