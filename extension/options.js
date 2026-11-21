document.addEventListener('DOMContentLoaded', async () => {
  async function getLocalStorage(defaults) {
    if (globalThis.browser) return globalThis.browser.storage.local.get(defaults);
    return new Promise(resolve => globalThis.chrome.storage.local.get(defaults, resolve));
  }

  async function setLocalStorage(values) {
    if (globalThis.browser) return globalThis.browser.storage.local.set(values);
    return new Promise((resolve, reject) => {
      globalThis.chrome.storage.local.set(values, () => {
        const error = globalThis.chrome.runtime.lastError;
        if (error) reject(new Error(error.message || 'Extension storage failed'));
        else resolve();
      });
    });
  }

  const profileForm = document.getElementById('profile-form');
  const profileStatus = document.getElementById('profile-status');
  const learnedBadge = document.getElementById('learned-count-badge');
  const learnedSearch = document.getElementById('learned-search-input');
  const learnedTable = document.getElementById('learned-table');
  const learnedBody = document.getElementById('learned-table-body');
  const learnedEmptyState = document.getElementById('learned-empty-state');
  const learnedStatus = document.getElementById('learned-status-msg');
  const clearAllLearnedBtn = document.getElementById('clear-all-learned-btn');
  const dataStatus = document.getElementById('data-status-msg');

  function showStatus(element, message, type = '') {
    if (!element) return;
    element.textContent = message;
    element.className = `status-msg ${type}`.trim();
  }

  function setTheme(theme) {
    const resolved = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  async function loadProfile() {
    const profile = await FormPilotStore.loadProfile();
    for (const [key, value] of Object.entries(profile)) {
      const field = profileForm.elements.namedItem(key);
      if (!field || value === null || value === undefined) continue;
      field.value = Array.isArray(value) ? value.join(', ') : String(value);
    }
  }

  try {
    await loadProfile();
  } catch (error) {
    showStatus(profileStatus, 'Could not load profile data.', 'error');
  }

  // Navigation
  const navButtons = Array.from(document.querySelectorAll('.nav-btn'));
  const panes = Array.from(document.querySelectorAll('.tab-pane'));
  navButtons.forEach(button => button.addEventListener('click', () => {
    navButtons.forEach(item => item.classList.toggle('active', item === button));
    panes.forEach(pane => pane.classList.toggle('active', pane.id === button.dataset.tab));
    if (button.dataset.tab === 'tab-learned') loadLearnedData();
  }));

  // Profile persistence
  profileForm.addEventListener('input', () => showStatus(profileStatus, 'Unsaved changes'));
  profileForm.addEventListener('change', () => showStatus(profileStatus, 'Unsaved changes'));
  profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('save-profile-btn');
    button.disabled = true;
    button.textContent = 'Saving…';

    const values = Object.fromEntries(new FormData(profileForm).entries());
    for (const [key, raw] of Object.entries(values)) {
      const field = profileForm.elements.namedItem(key);
      if (raw === '') {
        values[key] = null;
      } else if (field && field.type === 'number') {
        const number = Number(raw);
        values[key] = Number.isFinite(number) ? number : null;
      } else if (key === 'skills' || key === 'languages') {
        values[key] = String(raw).split(/[,;\n|]/).map(item => item.trim()).filter(Boolean);
      }
    }

    try {
      await FormPilotStore.saveProfile(values);
      showStatus(profileStatus, 'Profile saved in this browser.', 'success');
    } catch (error) {
      showStatus(profileStatus, 'Could not save profile.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save Profile';
    }
  });

  // Local appearance and autofill preferences
  const themeToggle = document.getElementById('theme-toggle');
  const highlightSlider = document.getElementById('highlight-slider');
  const highlightValue = document.getElementById('highlight-val');
  const demographicToggle = document.getElementById('demographic-autofill-toggle');

  try {
    const [stored, preferences] = await Promise.all([
      getLocalStorage({ theme: 'system' }),
      FormPilotStore.loadPreferences()
    ]);
    setTheme(stored.theme);
    themeToggle.checked = stored.theme === 'dark';
    const duration = Number(preferences.highlightDuration ?? 3);
    highlightSlider.value = Number.isFinite(duration) ? Math.max(1, Math.min(10, duration)) : 3;
    highlightValue.textContent = `${highlightSlider.value}s`;
    demographicToggle.checked = preferences.allowProtectedDemographicAutofill === true;
  } catch (error) {
    setTheme('light');
  }

  themeToggle.addEventListener('change', async event => {
    const theme = event.target.checked ? 'dark' : 'light';
    await setLocalStorage({ theme });
    setTheme(theme);
  });

  async function savePreferences() {
    const current = await FormPilotStore.loadPreferences();
    await FormPilotStore.savePreferences({
      ...current,
      highlightDuration: Number(highlightSlider.value),
      allowProtectedDemographicAutofill: demographicToggle.checked
    });
  }

  highlightSlider.addEventListener('input', () => {
    highlightValue.textContent = `${highlightSlider.value}s`;
  });
  highlightSlider.addEventListener('change', () => savePreferences().catch(() => {}));
  demographicToggle.addEventListener('change', () => savePreferences().catch(() => {}));

  // Locally stored learned corrections
  let learnedData = [];

  async function loadLearnedData() {
    try {
      learnedData = await FormPilotStore.loadCorrections();
      renderLearnedTable();
      showStatus(learnedStatus, '');
    } catch (error) {
      showStatus(learnedStatus, 'Could not load learned data.', 'error');
    }
  }

  function renderLearnedTable() {
    const filter = (learnedSearch.value || '').trim().toLowerCase();
    const entries = learnedData.filter(item => !filter
      || item.domain.toLowerCase().includes(filter)
      || item.field_label.toLowerCase().includes(filter)
      || item.corrected_value.toLowerCase().includes(filter));

    learnedBadge.textContent = `${learnedData.length} learned field${learnedData.length === 1 ? '' : 's'}`;
    learnedBody.replaceChildren();
    learnedTable.style.display = learnedData.length ? 'table' : 'none';
    learnedEmptyState.style.display = learnedData.length ? 'none' : 'block';
    clearAllLearnedBtn.style.display = learnedData.length ? 'inline-block' : 'none';

    if (!learnedData.length) return;
    if (!entries.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'no-matches-cell';
      cell.textContent = `No fields match “${filter}”.`;
      row.appendChild(cell);
      learnedBody.appendChild(row);
      return;
    }

    for (const item of entries) {
      const row = document.createElement('tr');
      row.appendChild(textCell(item.domain));
      row.appendChild(textCell(item.field_label));

      const valueCell = document.createElement('td');
      valueCell.className = 'value-container';
      valueCell.textContent = item.corrected_value;
      row.appendChild(valueCell);

      const actionCell = document.createElement('td');
      actionCell.className = 'actions-cell';
      const actions = document.createElement('div');
      actions.className = 'action-group';
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'btn-icon edit-btn';
      editButton.textContent = 'Edit';
      editButton.addEventListener('click', () => editCorrection(item, valueCell, editButton));
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'btn-icon delete-btn';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => deleteCorrection(item));
      actions.append(editButton, deleteButton);
      actionCell.appendChild(actions);
      row.appendChild(actionCell);
      learnedBody.appendChild(row);
    }
  }

  function textCell(text) {
    const cell = document.createElement('td');
    cell.textContent = text;
    return cell;
  }

  function editCorrection(item, cell, button) {
    if (button.dataset.editing === 'true') {
      const input = cell.querySelector('input');
      const updatedValue = input ? input.value.trim() : '';
      if (!updatedValue) return;
      FormPilotStore.updateCorrection(item.domain, item.field_label, updatedValue)
        .then(loadLearnedData)
        .then(() => showStatus(learnedStatus, 'Correction updated.', 'success'))
        .catch(() => showStatus(learnedStatus, 'Could not update correction.', 'error'));
      return;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-value-input';
    input.value = item.corrected_value;
    cell.replaceChildren(input);
    input.focus();
    input.select();
    button.textContent = 'Save';
    button.dataset.editing = 'true';
  }

  async function deleteCorrection(item) {
    if (!confirm(`Delete the learned value for “${item.field_label}” on ${item.domain}?`)) return;
    try {
      await FormPilotStore.deleteCorrection(item.domain, item.field_label);
      await loadLearnedData();
      showStatus(learnedStatus, 'Correction deleted.', 'success');
    } catch (error) {
      showStatus(learnedStatus, 'Could not delete correction.', 'error');
    }
  }

  learnedSearch.addEventListener('input', renderLearnedTable);
  clearAllLearnedBtn.addEventListener('click', async () => {
    if (!learnedData.length || !confirm(`Delete all ${learnedData.length} learned fields?`)) return;
    try {
      await FormPilotStore.clearCorrections();
      await loadLearnedData();
      showStatus(learnedStatus, 'All learned data deleted.', 'success');
    } catch (error) {
      showStatus(learnedStatus, 'Could not delete learned data.', 'error');
    }
  });

  // Explicit local data export/import and deletion
  document.getElementById('export-data-btn').addEventListener('click', async () => {
    try {
      const data = await FormPilotStore.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `formpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus(dataStatus, 'Backup exported.', 'success');
    } catch (error) {
      showStatus(dataStatus, 'Could not export data.', 'error');
    }
  });

  document.getElementById('import-data-input').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showStatus(dataStatus, 'Backup file is too large.', 'error');
      return;
    }
    if (!confirm('Importing this backup replaces the profile and learned corrections in this browser. Continue?')) return;
    try {
      await FormPilotStore.importData(JSON.parse(await file.text()));
      profileForm.reset();
      await loadProfile();
      await loadLearnedData();
      showStatus(dataStatus, 'Backup imported.', 'success');
    } catch (error) {
      showStatus(dataStatus, 'This file could not be imported as a FormPilot backup.', 'error');
    }
  });

  document.getElementById('delete-data-btn').addEventListener('click', async () => {
    if (!confirm('Delete the profile and all learned corrections from this browser? This cannot be undone.')) return;
    try {
      await FormPilotStore.clearUserData();
      profileForm.reset();
      await loadLearnedData();
      showStatus(dataStatus, 'Profile and learned data deleted.', 'success');
    } catch (error) {
      showStatus(dataStatus, 'Could not delete local data.', 'error');
    }
  });

  // Display data immediately if the learned-data tab is selected on load.
  if (document.querySelector('.nav-btn.active')?.dataset.tab === 'tab-learned') {
    loadLearnedData();
  }
});
