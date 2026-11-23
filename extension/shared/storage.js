// Local profile and correction storage shared by the Edge and Firefox builds.
(function (root) {
  const PROFILE_KEY = 'formpilotProfile';
  const CORRECTIONS_KEY = 'formpilotCorrections';
  const LEGACY_PREFERENCES_KEY = 'formpilotPreferences';
  const DATA_VERSION = 1;
  const api = root.browser || root.chrome;

  function storageCall(method, ...args) {
    if (root.browser) return root.browser.storage.local[method](...args);

    return new Promise((resolve, reject) => {
      api.storage.local[method](...args, (result) => {
        const error = api.runtime && api.runtime.lastError;
        if (error) reject(new Error(error.message || 'Extension storage failed'));
        else resolve(result);
      });
    });
  }

  function normalizeCorrectionLabel(label) {
    let normalized = String(label || '').toLowerCase().replace(/\xa0/g, ' ');
    normalized = normalized.replace(/[*_:;,()\/\\\-_.?!"'&|+@#%[\]{}<>]/g, ' ');
    return normalized.replace(/\s+/g, ' ').trim();
  }

  async function loadProfile() {
    const values = await storageCall('get', PROFILE_KEY);
    const profile = values && values[PROFILE_KEY];
    return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  }

  async function saveProfile(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new TypeError('Profile must be an object');
    }
    await storageCall('set', { [PROFILE_KEY]: profile });
  }

  async function loadCorrections() {
    const values = await storageCall('get', CORRECTIONS_KEY);
    const corrections = values && values[CORRECTIONS_KEY];
    return Array.isArray(corrections) ? corrections.filter(isValidCorrection) : [];
  }

  function isValidCorrection(item) {
    return item && typeof item === 'object'
      && typeof item.domain === 'string'
      && typeof item.field_label === 'string'
      && typeof item.corrected_value === 'string';
  }

async function saveCorrection(correction) {
  if (!isValidCorrection(correction) || !correction.field_label.trim()) {
    throw new TypeError('Correction is invalid');
  }

  const corrections = await loadCorrections();
  const labelKey = normalizeCorrectionLabel(correction.field_label);
  const index = corrections.findIndex(item =>
    normalizeCorrectionLabel(item.field_label) === labelKey);
  const clean = {
    domain: '',
    field_label: correction.field_label.trim(),
    corrected_value: correction.corrected_value,
    field_kind: correction.field_kind === 'option' ? 'option' : 'value',
    updated_at: new Date().toISOString()
  };

  if (index >= 0) corrections[index] = clean;
  else corrections.push(clean);
  await storageCall('set', { [CORRECTIONS_KEY]: corrections });
  return clean;
}

async function updateCorrection(fieldLabel, correctedValue) {
  const corrections = await loadCorrections();
  const labelKey = normalizeCorrectionLabel(fieldLabel);
  const item = corrections.find(entry =>
    normalizeCorrectionLabel(entry.field_label) === labelKey);
  if (!item) throw new Error('Correction not found');
  item.corrected_value = String(correctedValue);
  item.updated_at = new Date().toISOString();
  await storageCall('set', { [CORRECTIONS_KEY]: corrections });
}

async function deleteCorrection(fieldLabel) {
  const corrections = await loadCorrections();
  const labelKey = normalizeCorrectionLabel(fieldLabel);
  const updated = corrections.filter(entry =>
    !(normalizeCorrectionLabel(entry.field_label) === labelKey));
  await storageCall('set', { [CORRECTIONS_KEY]: updated });
}

  async function clearCorrections() {
    await storageCall('set', { [CORRECTIONS_KEY]: [] });
  }

  async function clearUserData() {
    await storageCall('remove', [PROFILE_KEY, CORRECTIONS_KEY, LEGACY_PREFERENCES_KEY]);
  }

  async function exportData() {
    const [profile, corrections] = await Promise.all([loadProfile(), loadCorrections()]);
    return { version: DATA_VERSION, profile, corrections };
  }

  async function importData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !data.profile || typeof data.profile !== 'object' || Array.isArray(data.profile)
      || !Array.isArray(data.corrections)) {
      throw new TypeError('This file is not a valid FormPilot backup');
    }

    const uniqueCorrections = new Map();
    for (const item of data.corrections.filter(isValidCorrection)) {
      const clean = {
        domain: '',
        field_label: item.field_label.trim(),
        corrected_value: item.corrected_value,
        field_kind: item.field_kind === 'option' ? 'option' : 'value',
        updated_at: item.updated_at || new Date().toISOString()
      };
      if (!clean.field_label) continue;
      uniqueCorrections.set(normalizeCorrectionLabel(clean.field_label), clean);
    }
    const corrections = Array.from(uniqueCorrections.values());

    await storageCall('set', {
      [PROFILE_KEY]: data.profile,
      [CORRECTIONS_KEY]: corrections
    });
  }

  root.FormPilotStore = {
    PROFILE_KEY,
    CORRECTIONS_KEY,
    loadProfile,
    saveProfile,
    loadCorrections,
    saveCorrection,
    updateCorrection,
    deleteCorrection,
    clearCorrections,
    clearUserData,
    exportData,
    importData
  };
})(globalThis);
