document.addEventListener('DOMContentLoaded', async () => {
  const api = globalThis.browser || globalThis.chrome;
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
  const pendingFields = new Map();
  let profileGeneration = null;
  let saveTimer;
  let statusTimer;
  let activeSave;

  function showStatus(element, message, type = '') {
    if (!element) return;
    element.textContent = message;
    element.className = `status-msg ${type}`.trim();
  }

  async function loadProfile() {
    const { profile, generation } = await FormPilotStore.loadProfileState();
    if (generation !== profileGeneration) {
      clearTimeout(saveTimer);
      clearTimeout(statusTimer);
      pendingFields.clear();
      profileGeneration = generation;
      showStatus(profileStatus, '');
    }
    for (const field of profileForm.elements) {
      if (!field.name || pendingFields.has(field.name)) continue;
      const value = profile[field.name];
      field.value = Array.isArray(value) ? value.join(', ') : String(value ?? '');
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
    navButtons.forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-current', active ? 'page' : 'false');
    });
    panes.forEach(pane => pane.classList.toggle('active', pane.id === button.dataset.tab));
    if (button.dataset.tab === 'tab-learned') loadLearnedData();
  }));

  // Section rail
  const railLinks = Array.from(document.querySelectorAll('.rail-link'));
  const railSections = railLinks
    .map(link => document.getElementById(link.dataset.rail))
    .filter(Boolean);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setActiveRail(id) {
    for (const link of railLinks) {
      const active = link.dataset.rail === id;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  const header = document.querySelector('.app-header');
  const sectionRail = document.querySelector('.section-rail');
  const stickyRail = window.matchMedia('(max-width: 1040px)');
  let sectionObserver;
  let previousOffset;

  function updateNavigationOffsets() {
    const headerHeight = Math.ceil(header.getBoundingClientRect().height);
    const railHeight = stickyRail.matches ? Math.ceil(sectionRail.getBoundingClientRect().height) : 0;
    const offset = headerHeight + railHeight + 18;
    document.documentElement.style.setProperty('--settings-header-height', headerHeight + 'px');
    document.documentElement.style.setProperty('--settings-scroll-offset', offset + 'px');
    if (offset === previousOffset) return;
    previousOffset = offset;
    sectionObserver?.disconnect();
    sectionObserver = new IntersectionObserver(entries => {
      const first = entries.filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (first) setActiveRail(first.target.id);
    }, { rootMargin: '-' + offset + 'px 0px -55% 0px' });
    railSections.forEach(section => sectionObserver.observe(section));
  }

  const navigationResize = new ResizeObserver(updateNavigationOffsets);
  navigationResize.observe(header);
  navigationResize.observe(sectionRail);
  stickyRail.addEventListener('change', updateNavigationOffsets);
  updateNavigationOffsets();

  railLinks.forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const target = document.getElementById(link.dataset.rail);
    if (!target) return;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setActiveRail(link.dataset.rail);
  }));

  // Dialogs
  const privacyDialog = document.getElementById('privacy-dialog');
  const aboutDialog = document.getElementById('about-dialog');
  document.getElementById('open-privacy-btn').addEventListener('click', () => privacyDialog.showModal());
  document.getElementById('open-about-btn').addEventListener('click', () => aboutDialog.showModal());
  [privacyDialog, aboutDialog].forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
  });

  // Save only fields edited in this tab.
  function showSavedStatus() {
    clearTimeout(statusTimer);
    showStatus(profileStatus, 'Saved to this browser.', 'success');
    statusTimer = setTimeout(() => showStatus(profileStatus, ''), 2500);
  }

  function profileValue(field) {
    const { name, value } = field;
    if (value === '') return null;
    if (field.type === 'number') return Number.isFinite(field.valueAsNumber) ? field.valueAsNumber : null;
    if (name === 'skills' || name === 'languages') {
      return value.split(/[,;\n|]/).map(item => item.trim()).filter(Boolean);
    }
    return value;
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (activeSave) return activeSave.then(saved => saved && saveNow());
    if (!pendingFields.size) return Promise.resolve(true);

    const savedFields = new Map(pendingFields);
    const values = Object.fromEntries(Array.from(savedFields, ([name, edit]) => [name, edit.value]));
    const generation = profileGeneration;
    activeSave = FormPilotStore.saveProfileChanges(values, generation)
      .then(async saved => {
        if (!saved) {
          await loadProfile();
          return false;
        }
        for (const [name, edit] of savedFields) {
          if (pendingFields.get(name) === edit) pendingFields.delete(name);
        }
        if (profileGeneration === generation && !pendingFields.size) showSavedStatus();
        return true;
      })
      .catch(() => {
        showStatus(profileStatus, 'Could not save profile. Try again.', 'error');
        return false;
      })
      .finally(() => { activeSave = undefined; });
    return activeSave;
  }

  function markDirty(event) {
    const field = event.target;
    if (!field.name || field.form !== profileForm) return;
    pendingFields.set(field.name, { value: profileValue(field) });
    clearTimeout(statusTimer);
    showStatus(profileStatus, 'Saving…', 'pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  }

  profileForm.addEventListener('input', markDirty);
  profileForm.addEventListener('change', markDirty);
  // Never submit the form itself (Enter in a field must not submit).
  profileForm.addEventListener('submit', event => event.preventDefault());

  // Flush any pending save when the tab is hidden / closed.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && pendingFields.size) void saveNow();
  });
  api.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[FormPilotStore.PROFILE_KEY] || changes[FormPilotStore.GENERATION_KEY]) {
      loadProfile().catch(() => showStatus(profileStatus, 'Could not load profile data.', 'error'));
    }
    if (changes[FormPilotStore.CORRECTIONS_KEY] && document.getElementById('tab-learned').classList.contains('active')) {
      loadLearnedData();
    }
  });

  // Locally stored learned corrections
  let learnedData = [];

  async function loadLearnedData() {
    showStatus(learnedStatus, 'Loading…', 'pending');
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
      || item.field_label.toLowerCase().includes(filter)
      || item.domain.toLowerCase().includes(filter)
      || item.corrected_value.toLowerCase().includes(filter));

    learnedBadge.textContent = `${learnedData.length} correction${learnedData.length === 1 ? '' : 's'}`;
    learnedBody.replaceChildren();
    learnedTable.style.display = learnedData.length ? 'table' : 'none';
    learnedEmptyState.style.display = learnedData.length ? 'none' : 'block';
    clearAllLearnedBtn.style.display = learnedData.length ? 'inline-block' : 'none';

    if (!learnedData.length) return;
    if (!entries.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'no-matches-cell';
      cell.textContent = `No fields match “${filter}”.`;
      row.appendChild(cell);
      learnedBody.appendChild(row);
      return;
    }

    for (const item of entries) {
      const row = document.createElement('tr');
      const labelCell = textCell(item.field_label);
      if (item.domain) {
        const site = document.createElement('small');
        site.className = 'correction-site';
        site.textContent = item.domain;
        labelCell.appendChild(site);
      }
      row.appendChild(labelCell);

      const valueCell = document.createElement('td');
      valueCell.className = 'value-container';
      valueCell.textContent = item.corrected_value;
      row.appendChild(valueCell);

      const actionCell = document.createElement('td');
      actionCell.className = 'actions-cell';
      const actions = document.createElement('div');
      actions.className = 'action-group';
      const editButton = iconButton(PENCIL_ICON, 'Edit correction');
      editButton.addEventListener('click', () => editCorrection(item, valueCell, editButton));
      const deleteButton = iconButton(TRASH_ICON, 'Delete correction');
      deleteButton.classList.add('delete-btn');
      deleteButton.addEventListener('click', () => deleteCorrection(item));
      actions.append(editButton, deleteButton);
      actionCell.appendChild(actions);
      row.appendChild(actionCell);
      learnedBody.appendChild(row);
    }
  }

  const PENCIL_ICON = ['M4.5 19.5h3l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z', 'M13.8 7.2l3 3'];
  const TRASH_ICON = [
    'M4.5 7h15',
    'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7',
    'M6.5 7l.8 11.2a1.8 1.8 0 0 0 1.8 1.8h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7'
  ];
  const CHECK_ICON = ['m5 12.5 4.5 4.5L19 7.5'];

  function createIcon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function iconButton(paths, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-icon';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.appendChild(createIcon(paths));
    return button;
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
        .catch(() => {
          resetEditButton(button);
          showStatus(learnedStatus, 'Could not update correction.', 'error');
        });
      return;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-value-input';
    input.value = item.corrected_value;
    cell.replaceChildren(input);
    input.focus();
    input.select();
    button.replaceChildren(createIcon(CHECK_ICON));
    button.classList.add('save-btn');
    button.setAttribute('aria-label', 'Save correction');
    button.title = 'Save correction';
    button.dataset.editing = 'true';
  }

  function resetEditButton(button) {
    button.replaceChildren(createIcon(PENCIL_ICON));
    button.classList.remove('save-btn');
    button.setAttribute('aria-label', 'Edit correction');
    button.title = 'Edit correction';
    button.dataset.editing = 'false';
  }

  async function deleteCorrection(item) {
    if (!confirm(`Delete the learned value for “${item.field_label}”?`)) return;
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

  // Explicit local data export, restore, and deletion
  document.getElementById('export-data-btn').addEventListener('click', async () => {
    try {
      if (!await saveNow()) throw new Error('Profile could not be saved');
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

  const importInput = document.getElementById('import-data-file');
  const importButton = document.getElementById('import-data-btn');
  importButton.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const [file] = importInput.files;
    importInput.value = '';
    if (!file) return;
    if (!confirm('Restore this backup and replace your current profile and learned corrections?')) return;
    importButton.disabled = true;
    try {
      const backup = JSON.parse(await file.text());
      await FormPilotStore.importData(backup);
      await loadProfile();
      await loadLearnedData();
      showStatus(dataStatus, 'Backup restored.', 'success');
    } catch (error) {
      const invalidFile = error instanceof SyntaxError || error instanceof TypeError;
      showStatus(dataStatus, invalidFile ? 'Choose a valid FormPilot backup.' : 'Could not restore the backup.', 'error');
    } finally {
      importButton.disabled = false;
    }
  });

  document.getElementById('delete-data-btn').addEventListener('click', async () => {
    if (!confirm('Delete the profile and all learned corrections from this browser? This cannot be undone.')) return;
    try {
      await FormPilotStore.clearUserData();
      await loadProfile();
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
