document.addEventListener('DOMContentLoaded', async () => {
  const api = globalThis.browser || globalThis.chrome;
  let tabId;
  const els = {
    host: document.getElementById('page-host'),
    card: document.getElementById('status-card'),
    title: document.getElementById('status-title'),
    detail: document.getElementById('status-detail'),
    fill: document.getElementById('fill-button'),
    secondary: document.getElementById('secondary-button'),
    panel: document.getElementById('result-panel'),
    counts: document.getElementById('result-counts'),
    details: document.getElementById('result-details'),
    progress: document.getElementById('progress-line')
  };

  function openSettings() {
    api.runtime.openOptionsPage();
  }

  function setState(state, title, detail, options = {}) {
    els.card.dataset.state = state;
    els.title.textContent = title;
    els.detail.textContent = detail;

    els.fill.hidden = true;
    els.fill.disabled = false;
    els.fill.onclick = null;

    els.secondary.hidden = true;
    els.secondary.onclick = null;

    if (options.primary) {
      els.fill.hidden = false;
      els.fill.textContent = options.primary.label;
      els.fill.onclick = options.primary.onClick;
    }
    if (options.secondary) {
      els.secondary.hidden = false;
      els.secondary.textContent = options.secondary.label;
      els.secondary.onclick = options.secondary.onClick;
    }
  }

  function renderResult(result) {
    const report = result.report || {};
    const total = Number(report.totalFields) || 0;
    const filled = Number(report.filled) || 0;
    const failed = Number(report.failed) || 0;
    const skipped = Math.max(0, total - filled - failed);

    els.panel.hidden = false;
    els.details.replaceChildren();

    els.counts.replaceChildren();
    els.counts.appendChild(countChip(filled, 'filled', 'chip-success'));
    if (skipped > 0) els.counts.appendChild(countChip(skipped, 'skipped'));
    if (failed > 0) els.counts.appendChild(countChip(failed, 'failed', 'chip-danger'));

    const details = Array.isArray(report.details) ? report.details : [];
    if (!details.length) {
      const note = document.createElement('li');
      note.className = 'empty-note';
      note.textContent = total === 0
        ? 'No supported form fields were found on this page.'
        : 'No field details are available.';
      els.details.appendChild(note);
    }

    for (const item of details) {
      const row = document.createElement('li');
      const line = document.createElement('div');
      line.className = 'detail-line';

      const label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = item.label || 'Unlabeled field';

      const state = document.createElement('span');
      state.className = `detail-status ${item.status}`;
      state.textContent = item.status === 'filled' ? 'Filled' : item.status === 'failed' ? 'Failed' : 'Skipped';

      line.append(label, state);
      row.appendChild(line);

      if (item.reason) {
        const reason = document.createElement('div');
        reason.className = 'detail-reason';
        reason.textContent = item.reason;
        row.appendChild(reason);
      }
      if (item.source && item.status === 'filled') {
        const source = document.createElement('div');
        source.className = 'detail-reason';
        source.textContent = `Source: ${item.source}`;
        row.appendChild(source);
      }
      els.details.appendChild(row);
    }

    const unreachable = Number(result.unreachableFrames) || 0;
    if (unreachable > 0) {
      const note = document.createElement('li');
      note.className = 'empty-note';
      note.textContent = `${unreachable} embedded frame${unreachable === 1 ? '' : 's'} could not be reached (cross-origin or blocked). Fill those manually.`;
      els.details.appendChild(note);
    }

    if (details.length === 50 && total > details.length) {
      const more = document.createElement('li');
      more.className = 'empty-note';
      more.textContent = `Showing the first ${details.length} fields.`;
      els.details.appendChild(more);
    }
  }

  function countChip(value, label, className) {
    const chip = document.createElement('span');
    chip.classList.add('chip');
    if (className) chip.classList.add(className);
    chip.textContent = `${value} ${label}`;
    return chip;
  }

  async function fillPage() {
    els.fill.disabled = true;
    els.fill.textContent = 'Filling…';
    els.panel.hidden = true;
    els.progress.classList.add('active');

    let next;
    try {
      const result = await api.runtime.sendMessage({ action: 'run_autofill', tabId });
      if (!result || !result.success) {
        next = {
          state: 'blocked',
          title: 'Could not fill this page',
          detail: (result && result.error) || 'Try reloading the page and try again.'
        };
      } else {
        renderResult(result);
        const filled = Number(result.report && result.report.filled) || 0;
        next = {
          state: 'done',
          title: filled ? `Filled ${filled} field${filled === 1 ? '' : 's'}` : 'Nothing was filled',
          detail: 'Review the results before submitting the form.',
          primary: { label: 'Fill again', onClick: fillPage }
        };
      }
    } catch (error) {
      next = {
        state: 'blocked',
        title: 'Could not fill this page',
        detail: 'FormPilot could not access this page. Try reloading it.'
      };
    }
    els.progress.classList.remove('active');
    setState(next.state, next.title, next.detail, next);
  }

  async function init() {
    let url = null;
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      tabId = tab?.id;
      url = tab && tab.url ? new URL(tab.url) : null;
    } catch (error) { /* treat as unsupported */ }

    const supportedProtocol = Boolean(url) && ['http:', 'https:'].includes(url.protocol);
    els.host.textContent = supportedProtocol ? url.hostname : 'Current page';

    let hasProfile = false;
    try {
      const { profile, corrections } = await FormPilotStore.loadUserData();
      hasProfile = FormPilotStore.hasProfileValue(profile)
        || corrections.some(item => !item.domain || item.domain === url?.hostname);
    } catch (error) { /* treat as empty */ }

    if (!hasProfile) {
      setState('warn', 'Set up your profile first', 'Add your details so FormPilot knows what to fill.', {
        primary: { label: 'Set up profile', onClick: openSettings }
      });
      return;
    }

    if (!supportedProtocol) {
      setState('blocked', "Can't fill this page", 'FormPilot cannot access this page. Try a regular webpage instead.');
      return;
    }

    setState('loading', 'Checking this page…', 'Looking for fields FormPilot can fill.');

    let detection = null;
    try {
      detection = await api.runtime.sendMessage({ action: 'detect_fields', tabId });
    } catch (error) { detection = null; }

    if (!detection || !detection.success) {
      setState('blocked', "Can't fill this page", 'FormPilot could not inspect this page. Try reloading it.');
      return;
    }

    const supported = Number(detection.supportedFields) || 0;
    const matched = Number(detection.matchedFields) || 0;
    const existing = Number(detection.existingFields) || 0;
    const unreachable = Number(detection.unreachableFrames) || 0;

    if (supported === 0 && unreachable > 0) {
      setState('warn', 'Some embedded frames are out of reach', `FormPilot could not inspect ${unreachable} embedded frame${unreachable === 1 ? '' : 's'} on this page.`);
      return;
    }

    if (supported === 0) {
      setState('warn', 'No supported fields found', "This page doesn't appear to contain any fields FormPilot can fill.");
      return;
    }

    if (matched === 0) {
      const detail = existing > 0
        ? 'Matching fields already have values.'
        : 'No empty fields have a supported match for your saved details.';
      setState('warn', 'Nothing to fill yet', detail, {
        secondary: { label: 'Edit profile', onClick: openSettings }
      });
      return;
    }

    const detail = unreachable > 0
      ? `FormPilot found fields to fill. It could not inspect ${unreachable} embedded frame${unreachable === 1 ? '' : 's'}.`
      : 'FormPilot found fields it can fill on this page.';
    setState('ready', 'Ready to fill', detail, {
      primary: { label: 'Fill this page', onClick: fillPage }
    });
  }

  document.getElementById('settings-button').addEventListener('click', openSettings);
  await init();
});
