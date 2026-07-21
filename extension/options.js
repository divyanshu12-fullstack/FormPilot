const API_BASE = 'http://127.0.0.1:8420';

document.addEventListener('DOMContentLoaded', async () => {
  // 0. Backend Health Check
  const backendDot = document.getElementById('backend-dot');
  const backendText = document.getElementById('backend-status-text');
  
  async function checkBackend() {
    try {
      const res = await fetch(`${API_BASE}/ping`, { method: 'GET' });
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
    });
  });

  // 2. Profile Tab Logic
  const profileForm = document.getElementById('profile-form');
  const profileStatus = document.getElementById('profile-status');
  
  // Fetch profile
  try {
    const res = await fetch(`${API_BASE}/profile`);
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
      const res = await fetch(`${API_BASE}/profile`, {
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
    const res = await fetch(`${API_BASE}/resume`);
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
      const res = await fetch(`${API_BASE}/resume/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.structured) {
        uploadStatus.textContent = 'Resume successfully structured and saved!';
        uploadStatus.className = 'status-msg success';
        
        // Refetch to get full structured_json for the summary
        const res2 = await fetch(`${API_BASE}/resume`);
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

});
