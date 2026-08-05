document.addEventListener('DOMContentLoaded', async () => {
  // 0. Backend Health Check
  const backendDot = document.getElementById('backend-dot');
  const backendText = document.getElementById('backend-status-text');
  
  async function checkBackend() {
    try {
      const apiBase = await getApiBase();
      const res = await fetch(`${apiBase}/ping`, { method: 'GET' });
      if (res.ok) {
        backendDot.className = 'status-dot online';
        backendText.textContent = 'Backend: Connected';
      } else {
        throw new Error();
      }
    } catch {
      backendDot.className = 'status-dot offline';
      backendText.textContent = 'Backend: Offline';
    }
  }
  checkBackend();
  setInterval(checkBackend, 10000);

  // 1. Tab Switching Logic
  const navBtns = document.querySelectorAll('.nav-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active from all
      navBtns.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));
      
      // Add active to clicked
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');

      if (targetId === 'tab-learned') {
        loadLearnedData();
      }
    });
  });

  // 2. Profile Tab Logic
  const profileForm = document.getElementById('profile-form');
  const profileStatus = document.getElementById('profile-status');
  
  // Fetch profile
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/profile`);
    if (res.ok) {
      const data = await res.json();
      for (const [key, val] of Object.entries(data)) {
        if (profileForm.elements[key] && val !== null) {
          profileForm.elements[key].value = val;
        }
      }
    }
  } catch (e) {
    console.error('Failed to load profile', e);
  }

  // Handle Unsaved changes indicator
  const inputs = profileForm.querySelectorAll('input');
  inputs.forEach(input => {
    input.addEventListener('input', () => {
      if (profileStatus.textContent !== 'Unsaved changes') {
        profileStatus.textContent = 'Unsaved changes';
        profileStatus.className = 'status-msg'; // default grey color
      }
    });
  });

  // Save profile
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('save-profile-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    profileStatus.textContent = '';
    
    const formData = new FormData(profileForm);
    const data = Object.fromEntries(formData.entries());
    
    // Convert empty strings to null and handle numbers
    for (const key in data) {
      if (data[key] === '') data[key] = null;
    }
    if (data.experience_years) {
      data.experience_years = parseInt(data.experience_years, 10);
    }

    try {
      const apiBase = await getApiBase();
      const res = await fetch(`${apiBase}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        profileStatus.textContent = 'Saved successfully!';
        profileStatus.className = 'status-msg success';
        
        // Morph button
        const originalWidth = btn.offsetWidth;
        btn.textContent = 'Saved ✓';
        btn.classList.add('pulse-success');
        btn.style.width = originalWidth + 'px'; // keep width stable during morph
      } else {
        throw new Error('Failed to save');
      }
    } catch (err) {
      profileStatus.textContent = 'Error saving profile.';
      profileStatus.className = 'status-msg error';
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Save Profile';
        btn.classList.remove('pulse-success');
        btn.style.width = ''; // reset width
        if (profileStatus.textContent === 'Saved successfully!') {
          profileStatus.textContent = '';
        }
      }, 2000);
    }
  });

  // 3. Resume Tab Logic
  const resumeFilename = document.getElementById('resume-filename');
  const resumeSummary = document.getElementById('resume-summary');
  const uploadBtn = document.getElementById('upload-resume-btn');
  const fileInput = document.getElementById('resume-file');
  const uploadStatus = document.getElementById('upload-status');
  const dropZone = document.getElementById('drop-zone');
  const selectedFilename = document.getElementById('selected-filename');

  function updateResumeSummary(data) {
    resumeFilename.innerHTML = 'Resume processed &mdash; ready to use <span style="color:#2e7d32">✓</span>';
    
    // Calculate summary from structured_json
    if (data.structured_json) {
      const exps = data.structured_json.experience ? data.structured_json.experience.length : 0;
      const skills = data.structured_json.skills ? data.structured_json.skills.length : 0;
      const edus = data.structured_json.education ? data.structured_json.education.length : 0;
      resumeSummary.textContent = `Found ${exps} work experience${exps !== 1 ? 's' : ''}, ${skills} skill${skills !== 1 ? 's' : ''}, and ${edus} education entry${edus !== 1 ? 'ies' : ''}.`;
    } else {
      resumeSummary.textContent = '';
    }
  }

  // Fetch current resume status
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/resume`);
    if (res.ok) {
      const data = await res.json();
      if (data && Object.keys(data).length > 0) {
        updateResumeSummary(data);
      } else {
        resumeFilename.textContent = 'No resume data found.';
        resumeSummary.textContent = 'Upload a resume below to get started.';
      }
    }
  } catch (e) {
    resumeFilename.textContent = 'Error connecting to backend';
  }

  // File Drag & Drop Handlers
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files;
      handleFileSelection();
    }
  });

  fileInput.addEventListener('change', handleFileSelection);

  function handleFileSelection() {
    const file = fileInput.files[0];
    if (file) {
      selectedFilename.textContent = file.name;
      uploadBtn.disabled = false;
    } else {
      selectedFilename.textContent = 'No file chosen';
      uploadBtn.disabled = true;
    }
  }

  // Upload new resume
  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    
    uploadBtn.disabled = true;
    uploadBtn.classList.add('loading');
    uploadBtn.textContent = 'Processing...';
    uploadStatus.textContent = 'Sending to AI for structuring (this takes a few seconds)...';
    uploadStatus.className = 'status-msg';

    const formData = new FormData();
    formData.append('file', file);

    try {
      const apiBase = await getApiBase();
      const res = await fetch(`${apiBase}/resume/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.structured) {
        uploadStatus.textContent = 'Resume successfully structured and saved!';
        uploadStatus.className = 'status-msg success';
        
        // Refetch to get full structured_json for the summary
        const res2 = await fetch(`${apiBase}/resume`);
        const data2 = await res2.json();
        updateResumeSummary(data2);
      } else {
        throw new Error('Structuring failed');
      }
    } catch (err) {
      uploadStatus.textContent = 'Failed to process resume. Check backend logs.';
      uploadStatus.className = 'status-msg error';
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.classList.remove('loading');
      uploadBtn.textContent = 'Process Resume';
    }
  });

  // 4. Preferences Tab Logic
  const slider = document.getElementById('highlight-slider');
  const sliderVal = document.getElementById('highlight-val');
  const autoDraftToggle = document.getElementById('auto-draft-toggle');
  const themeToggle = document.getElementById('theme-toggle');
  const apiUrlInput = document.getElementById('api-url-input');

  // Load API URL
  if (apiUrlInput) {
    getApiBase().then(url => {
      apiUrlInput.value = url;
    });
    apiUrlInput.addEventListener('change', (e) => {
      setApiBase(e.target.value).then(cleanUrl => {
        apiUrlInput.value = cleanUrl;
        checkBackend();
      });
    });
  }

  // Load from chrome.storage
  chrome.storage.local.get({ theme: 'system' }, (items) => {
    let activeTheme = items.theme;
    if (activeTheme === 'system') {
      activeTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    themeToggle.checked = (activeTheme === 'dark');
  });

  chrome.storage.sync.get({ highlightDuration: 3, autoDraftMode: false }, (items) => {
    slider.value = items.highlightDuration;
    sliderVal.textContent = items.highlightDuration + 's';
    autoDraftToggle.checked = items.autoDraftMode;
  });

  // Save on change
  themeToggle.addEventListener('change', (e) => {
    const newTheme = e.target.checked ? 'dark' : 'light';
    chrome.storage.local.set({ theme: newTheme });
    document.documentElement.setAttribute('data-theme', newTheme);
  });

  slider.addEventListener('input', (e) => {
    const val = e.target.value;
    sliderVal.textContent = val + 's';
    chrome.storage.sync.set({ highlightDuration: parseInt(val, 10) });
  });

  autoDraftToggle.addEventListener('change', (e) => {
    chrome.storage.sync.set({ autoDraftMode: e.target.checked });
  });

  // 5. Learned Data Tab Logic
  const learnedBadge = document.getElementById('learned-count-badge');
  const learnedSearch = document.getElementById('learned-search-input');
  const learnedTable = document.getElementById('learned-table');
  const learnedBody = document.getElementById('learned-table-body');
  const learnedEmptyState = document.getElementById('learned-empty-state');
  const learnedStatus = document.getElementById('learned-status-msg');
  const clearAllLearnedBtn = document.getElementById('clear-all-learned-btn');

  let learnedDataStore = {};

  async function loadLearnedData() {
    try {
      const apiBase = await getApiBase();
      const res = await fetch(`${apiBase}/corrections`);
      if (res.ok) {
        learnedDataStore = await res.json();
        renderLearnedTable();
      } else {
        throw new Error('Failed to load corrections');
      }
    } catch (err) {
      console.error('Error loading learned data:', err);
      learnedBadge.textContent = 'Error loading';
      learnedStatus.textContent = 'Could not load learned data. Is the backend running?';
      learnedStatus.className = 'status-msg error';
    }
  }

  function renderLearnedTable() {
    const filter = (learnedSearch?.value || '').toLowerCase().trim();
    const entries = Object.entries(learnedDataStore).filter(([label, val]) => {
      if (!filter) return true;
      return label.toLowerCase().includes(filter) || String(val).toLowerCase().includes(filter);
    });

    const totalCount = Object.keys(learnedDataStore).length;
    learnedBadge.textContent = `${totalCount} learned field${totalCount !== 1 ? 's' : ''}`;

    if (totalCount === 0) {
      learnedTable.style.display = 'none';
      learnedEmptyState.style.display = 'block';
      if (clearAllLearnedBtn) clearAllLearnedBtn.style.display = 'none';
      return;
    }

    learnedTable.style.display = 'table';
    learnedEmptyState.style.display = 'none';
    if (clearAllLearnedBtn) clearAllLearnedBtn.style.display = 'inline-block';

    learnedBody.innerHTML = '';

    if (entries.length === 0) {
      const emptyRow = document.createElement('tr');
      emptyRow.innerHTML = `<td colspan="3" style="text-align: center; color: var(--text-muted); padding: 24px;">No fields match "${filter}"</td>`;
      learnedBody.appendChild(emptyRow);
      return;
    }

    entries.forEach(([label, value]) => {
      const tr = document.createElement('tr');
      tr.dataset.label = label;

      tr.innerHTML = `
        <td><span class="field-label-cell">${escapeHtml(label)}</span></td>
        <td class="value-container">
          <span class="field-value-cell">${escapeHtml(value || '(empty)')}</span>
        </td>
        <td style="text-align: right;">
          <div class="action-group">
            <button class="btn-icon edit-btn" title="Edit this value">✏️ Edit</button>
            <button class="btn-icon delete-btn" title="Delete this learned field">🗑️ Delete</button>
          </div>
        </td>
      `;

      const editBtn = tr.querySelector('.edit-btn');
      const deleteBtn = tr.querySelector('.delete-btn');
      const valueContainer = tr.querySelector('.value-container');

      editBtn.addEventListener('click', () => {
        if (editBtn.classList.contains('save-btn')) {
          // Save action
          const input = valueContainer.querySelector('input');
          if (input) {
            saveSingleCorrection(label, input.value.trim(), tr);
          }
        } else {
          // Enter Edit mode
          const currentVal = learnedDataStore[label] || '';
          valueContainer.innerHTML = `<input type="text" class="field-value-input" value="${escapeHtml(currentVal)}">`;
          const input = valueContainer.querySelector('input');
          input.focus();
          input.select();

          editBtn.textContent = '💾 Save';
          editBtn.classList.add('save-btn');

          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              saveSingleCorrection(label, input.value.trim(), tr);
            } else if (e.key === 'Escape') {
              renderLearnedTable();
            }
          });
        }
      });

      deleteBtn.addEventListener('click', async () => {
        if (confirm(`Are you sure you want to delete the learned value for "${label}"?`)) {
          deleteSingleCorrection(label, tr);
        }
      });

      learnedBody.appendChild(tr);
    });
  }

  async function saveSingleCorrection(label, newValue, rowEl) {
    try {
      const apiBase = await getApiBase();
      const res = await fetch(`${apiBase}/corrections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_label: label, corrected_value: newValue })
      });
      if (res.ok) {
        learnedDataStore[label] = newValue;
        showLearnedStatus(`Updated "${label}"`, 'success');
        renderLearnedTable();
      } else {
        throw new Error('Update failed');
      }
    } catch (err) {
      showLearnedStatus(`Failed to update "${label}"`, 'error');
    }
  }

  async function deleteSingleCorrection(label, rowEl) {
    try {
      const apiBase = await getApiBase();
      const res = await fetch(`${apiBase}/corrections/${encodeURIComponent(label)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        delete learnedDataStore[label];
        showLearnedStatus(`Deleted "${label}"`, 'success');
        renderLearnedTable();
      } else {
        throw new Error('Delete failed');
      }
    } catch (err) {
      showLearnedStatus(`Failed to delete "${label}"`, 'error');
    }
  }

  if (clearAllLearnedBtn) {
    clearAllLearnedBtn.addEventListener('click', async () => {
      const count = Object.keys(learnedDataStore).length;
      if (count === 0) return;
      if (confirm(`Are you sure you want to delete ALL ${count} learned field entries? This cannot be undone.`)) {
        try {
          const apiBase = await getApiBase();
          const res = await fetch(`${apiBase}/corrections`, { method: 'DELETE' });
          if (res.ok) {
            learnedDataStore = {};
            showLearnedStatus('All learned data cleared', 'success');
            renderLearnedTable();
          } else {
            throw new Error('Clear failed');
          }
        } catch (err) {
          showLearnedStatus('Failed to clear learned data', 'error');
        }
      }
    });
  }

  if (learnedSearch) {
    learnedSearch.addEventListener('input', () => {
      renderLearnedTable();
    });
  }

  function showLearnedStatus(msg, type = 'info') {
    if (!learnedStatus) return;
    learnedStatus.textContent = msg;
    learnedStatus.className = `status-msg ${type}`;
    setTimeout(() => {
      if (learnedStatus.textContent === msg) {
        learnedStatus.textContent = '';
      }
    }, 3000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Load learned data on initial page load if tab is active
  const activeTab = document.querySelector('.nav-btn.active');
  if (activeTab && activeTab.getAttribute('data-tab') === 'tab-learned') {
    loadLearnedData();
  }

});

