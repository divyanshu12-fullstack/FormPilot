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

const REPORT_COUNTERS = [
  'totalFields', 'filled', 'ambiguous', 'noOption', 'noValue', 'deferred',
  'unsupported', 'skipped', 'failed', 'consent', 'blocked', 'unmatched'
];
const tabOperations = new Map();

function describeFrame() {
  // This probe runs in the extension's isolated world without any user data.
  try {
    for (let frame = window; frame !== window.top; frame = frame.parent) {
      void frame.parent.document;
    }
  } catch (error) {
    return null;
  }
  return {
    origin: window.origin,
    children: window.length,
    ready: globalThis.formPilotContentReady === true
  };
}

async function messageTab(tab, message) {
  const origin = new URL(tab.url || '').origin;
  const tabId = tab.id;
  let frames;
  try {
    frames = await FormPilotAPI.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: describeFrame
    });
  } catch (error) {
    frames = await FormPilotAPI.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: describeFrame
    });
  }
  const eligible = frames.filter(frame => frame.result?.origin === origin);
  if (!eligible.some(frame => frame.frameId === 0)) {
    throw new Error('The page changed. Reopen FormPilot and try again.');
  }
  const results = await Promise.allSettled(eligible.map(async frame => {
    const { frameId, documentId } = frame;
    if (!frame.result.ready) {
      await FormPilotAPI.scripting.executeScript({
        target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] },
        world: 'ISOLATED',
        files: CONTENT_FILES
      });
    }
    const response = await FormPilotAPI.tabs.sendMessage(tabId, { ...message, origin },
      documentId ? { documentId } : { frameId });
    if (!response?.success) throw new Error(response?.error || 'FormPilot could not read the frame.');
    return response;
  }));

  const main = results[eligible.findIndex(frame => frame.frameId === 0)];
  if (main.status === 'rejected') throw main.reason;
  const reachable = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const frameCount = eligible.reduce((sum, frame) => sum + frame.result.children, 0);
  const unreachableFrames = Math.max(0, frameCount - (reachable.length - 1));
  if (message.action === 'detect') {
    return reachable.reduce((totals, result) => {
      totals.supportedFields += result.supportedFields;
      totals.matchedFields += result.matchedFields;
      totals.existingFields += result.existingFields;
      return totals;
    }, { success: true, supportedFields: 0, matchedFields: 0, existingFields: 0, unreachableFrames });
  }

  const report = Object.fromEntries(REPORT_COUNTERS.map(key => [key, 0]));
  for (const { report: local } of reachable) {
    for (const key of REPORT_COUNTERS) report[key] += local[key];
  }
  report.details = reachable.flatMap(result => result.report.details).slice(0, 50);
  return { success: true, report, unreachableFrames };
}

async function setTabBadge(tabId, text) {
  try {
    await FormPilotAPI.action.setBadgeText({ tabId, text: String(text || '').slice(0, 4) });
  } catch (error) {
    // Badge support is a convenience; it must not affect filling.
  }
}

async function runAutofill(tab) {
  const data = await dataForTab(tab);
  if (!FormPilotStore.hasProfileValue(data.profile) && !data.corrections.length) {
    await setTabBadge(tab.id, '');
    return { success: false, error: 'Add profile details before filling a form.' };
  }

  try {
    const result = await messageTab(tab, { action: 'autofill', ...data });
    await setTabBadge(tab.id, result.report.filled || '');
    return result;
  } catch (error) {
    await setTabBadge(tab.id, '!');
    throw error;
  }
}

async function detectFields(tab) {
  return messageTab(tab, { action: 'detect', ...await dataForTab(tab) });
}

async function dataForTab(tab) {
  const domain = new URL(tab.url || '').hostname;
  const { profile, corrections, generation } = await FormPilotStore.loadUserData();
  // Keep any older site-specific correction ahead of the global fallback.
  const scoped = corrections.filter(item => item.domain === domain);
  const global = corrections.filter(item => item.domain === '');
  return { profile, corrections: [...scoped, ...global], generation };
}

async function forActiveTab(expectedId, operation) {
  const [tab] = await FormPilotAPI.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id !== expectedId || !/^https?:\/\//.test(tab.url || '')) {
    throw new Error('The active page changed. Reopen FormPilot and try again.');
  }
  const previous = tabOperations.get(tab.id);
  const work = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => operation(tab));
  tabOperations.set(tab.id, work);
  try {
    return await work;
  } finally {
    if (tabOperations.get(tab.id) === work) tabOperations.delete(tab.id);
  }
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

  if (message.action === 'run_autofill' || message.action === 'detect_fields') {
    if (sender.url !== FormPilotAPI.runtime.getURL('popup.html')) return false;
    const operation = message.action === 'run_autofill' ? runAutofill : detectFields;
    forActiveTab(message.tabId, operation)
      .then(sendResponse)
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'save_correction') {
    const domain = correctionDomain(sender);
    const label = String(message.field_label || '').trim().slice(0, 200);
    const value = String(message.corrected_value || '').slice(0, 5000);
    if (typeof sender.tab?.id !== 'number' || !domain || !label || !value.trim()) {
      sendResponse({ success: false, error: 'Correction is incomplete.' });
      return false;
    }

    FormPilotStore.saveCorrection({
      domain: message.domain === domain ? domain : '',
      field_label: label,
      corrected_value: value,
      field_kind: message.field_kind
    }, message.generation).then(saved => sendResponse({ success: saved }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});
