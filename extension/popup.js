document.addEventListener('DOMContentLoaded', async () => {
  const extensionApi = globalThis.browser || globalThis.chrome;
  const hostElement = document.getElementById('page-host');
  const fillButton = document.getElementById('fill-button');
  const statusElement = document.getElementById('status');
  const resultPanel = document.getElementById('result-panel');
  const resultCounts = document.getElementById('result-counts');
  const resultDetails = document.getElementById('result-details');

  function setStatus(message) {
    statusElement.textContent = message;
  }

  function renderResult(result) {
    resultPanel.hidden = false;
    resultDetails.replaceChildren();
    const report = result.report || {};
    const total = Number(report.totalFields) || 0;
    const filled = Number(report.filled) || 0;
    const skipped = Math.max(0, total - filled - (Number(report.failed) || 0));
    const failed = Number(report.failed) || 0;
    resultCounts.textContent = `${filled} filled · ${skipped} skipped · ${failed} failed`;

    const details = Array.isArray(report.details) ? report.details : [];
    if (!details.length) {
      const empty = document.createElement('li');
      empty.textContent = total === 0
        ? 'No supported form fields were found on this page.'
        : 'No field details are available.';
      resultDetails.appendChild(empty);
      return;
    }

    for (const item of details) {
      const row = document.createElement('li');
      const line = document.createElement('div');
      line.className = 'detail-line';
      const label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = item.label || 'Unlabeled field';
      const state = document.createElement('span');
      state.className = 'detail-status';
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
      resultDetails.appendChild(row);
    }

    if (details.length === 50 && total > details.length) {
      const more = document.createElement('li');
      more.textContent = `Showing first ${details.length} fields.`;
      resultDetails.appendChild(more);
    }
  }

  try {
    const tabs = await extensionApi.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    const pageUrl = tab && tab.url ? new URL(tab.url) : null;
    hostElement.textContent = pageUrl && ['http:', 'https:'].includes(pageUrl.protocol)
      ? pageUrl.hostname
      : 'This page cannot be filled';

    const profile = await FormPilotStore.loadProfile();
    const hasProfileValue = Object.values(profile).some(value => Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && String(value).trim() !== '');
    if (!hasProfileValue) {
      setStatus('Add profile details before filling a form.');
    } else if (!pageUrl || !['http:', 'https:'].includes(pageUrl.protocol)) {
      setStatus('Open a regular web page to use autofill.');
    } else {
      fillButton.disabled = false;
      setStatus('Review the page, then choose Fill this page.');
    }
  } catch (error) {
    setStatus('Could not read your local profile. Open Profile & settings to check it.');
  }

  fillButton.addEventListener('click', async () => {
    fillButton.disabled = true;
    setStatus('Checking fields and filling safe matches…');
    resultPanel.hidden = true;
    try {
      const result = await extensionApi.runtime.sendMessage({ action: 'run_autofill' });
      if (!result || !result.success) {
        setStatus(result && result.error ? result.error : 'FormPilot could not fill this page.');
        return;
      }
      renderResult(result);
      setStatus('Review the results before submitting the form.');
    } catch (error) {
      setStatus('FormPilot could not access this page. Check the site permission and try again.');
    } finally {
      fillButton.disabled = false;
    }
  });

  document.getElementById('settings-button').addEventListener('click', () => {
    extensionApi.runtime.openOptionsPage();
  });
});
