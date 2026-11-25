// Local profile and correction storage shared by the Edge and Firefox builds.
(function (root) {
  const PROFILE_KEY = 'formpilotProfile';
  const CORRECTIONS_KEY = 'formpilotCorrections';
  const LEGACY_PREFERENCES_KEY = 'formpilotPreferences';
  const GENERATION_KEY = 'formpilotDataGeneration';
  const DATA_VERSION = 1;
  const api = root.browser || root.chrome;
  let pendingWrite = Promise.resolve();

  function writeData(task) {
    // The lock is shared by settings tabs and the background worker.
    if (root.navigator?.locks) return root.navigator.locks.request('formpilot-data', task);
    const result = pendingWrite.then(task);
    pendingWrite = result.catch(() => {});
    return result;
  }

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
    return profileFrom(values);
  }

  function profileFrom(values) {
    const profile = values?.[PROFILE_KEY];
    return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  }

  function hasProfileValue(profile) {
    return Object.values(profile).some(value => Array.isArray(value)
      ? value.some(item => String(item).trim() !== '')
      : value !== null && value !== undefined && String(value).trim() !== '');
  }

  async function loadProfileState() {
    const values = await storageCall('get', [PROFILE_KEY, GENERATION_KEY]);
    return { profile: profileFrom(values), generation: values?.[GENERATION_KEY] ?? null };
  }

  function saveProfileChanges(changes, generation) {
    return writeData(async () => {
      const current = await loadProfileState();
      if (current.generation !== generation) return false;
      await storageCall('set', { [PROFILE_KEY]: { ...current.profile, ...changes } });
      return true;
    });
  }

  async function loadCorrections() {
    const values = await storageCall('get', CORRECTIONS_KEY);
    return correctionsFrom(values);
  }

  function correctionsFrom(values) {
    const corrections = values?.[CORRECTIONS_KEY];
    return Array.isArray(corrections) ? corrections.filter(isValidCorrection) : [];
  }

  async function loadUserData() {
    const values = await storageCall('get', [PROFILE_KEY, CORRECTIONS_KEY, GENERATION_KEY]);
    return {
      profile: profileFrom(values),
      corrections: correctionsFrom(values),
      generation: values?.[GENERATION_KEY] ?? null
    };
  }

  function isValidCorrection(item) {
    return item && typeof item === 'object'
      && typeof item.domain === 'string'
      && typeof item.field_label === 'string'
      && typeof item.corrected_value === 'string';
  }

  function correctionKey(domain, label) {
    return JSON.stringify([domain, normalizeCorrectionLabel(label)]);
  }

  function cleanCorrection(item) {
    return {
      domain: item.domain.trim().toLowerCase(),
      field_label: item.field_label.trim(),
      corrected_value: item.corrected_value,
      field_kind: item.field_kind === 'option' ? 'option' : 'value',
      updated_at: typeof item.updated_at === 'string' ? item.updated_at : new Date().toISOString()
    };
  }

  function saveCorrection(correction, generation) {
    if (!isValidCorrection(correction) || !normalizeCorrectionLabel(correction.field_label)) {
      throw new TypeError('Correction is invalid');
    }
    return writeData(async () => {
      const current = await loadUserData();
      if (current.generation !== generation) return false;
      const clean = cleanCorrection(correction);
      const key = correctionKey(clean.domain, clean.field_label);
      const index = current.corrections.findIndex(item => correctionKey(item.domain, item.field_label) === key);
      if (index >= 0) current.corrections[index] = clean;
      else current.corrections.push(clean);
      await storageCall('set', { [CORRECTIONS_KEY]: current.corrections });
      return true;
    });
  }

  function updateCorrection(domain, fieldLabel, correctedValue) {
    return writeData(async () => {
      const corrections = await loadCorrections();
      const key = correctionKey(domain, fieldLabel);
      const item = corrections.find(entry => correctionKey(entry.domain, entry.field_label) === key);
      if (!item) throw new Error('Correction not found');
      item.corrected_value = String(correctedValue);
      item.updated_at = new Date().toISOString();
      await storageCall('set', { [CORRECTIONS_KEY]: corrections });
    });
  }

  function deleteCorrection(domain, fieldLabel) {
    return writeData(async () => {
      const key = correctionKey(domain, fieldLabel);
      const corrections = await loadCorrections();
      const updated = corrections.filter(entry => correctionKey(entry.domain, entry.field_label) !== key);
      await storageCall('set', { [CORRECTIONS_KEY]: updated });
    });
  }

  function clearCorrections() {
    return writeData(() => storageCall('set', { [CORRECTIONS_KEY]: [] }));
  }

  function clearUserData() {
    return writeData(async () => {
      await replaceUserData({}, []);
      await storageCall('remove', LEGACY_PREFERENCES_KEY);
    });
  }

  async function exportData() {
    const { profile, corrections } = await loadUserData();
    return { version: DATA_VERSION, profile, corrections };
  }

  function isProfileValue(value) {
    return value === null || typeof value === 'string' || typeof value === 'boolean'
      || Number.isFinite(value) || (Array.isArray(value) && value.every(item => typeof item === 'string'));
  }

  async function importData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || (data.version !== undefined && data.version !== DATA_VERSION)
      || !data.profile || typeof data.profile !== 'object' || Array.isArray(data.profile)
      || !Object.values(data.profile).every(isProfileValue)
      || !Array.isArray(data.corrections) || !data.corrections.every(isValidCorrection)) {
      throw new TypeError('This file is not a valid FormPilot backup');
    }

    const uniqueCorrections = new Map();
    for (const item of data.corrections) {
      const clean = cleanCorrection(item);
      if (!normalizeCorrectionLabel(clean.field_label) || !clean.corrected_value.trim()) continue;
      uniqueCorrections.set(correctionKey(clean.domain, clean.field_label), clean);
    }
    await writeData(() => replaceUserData(data.profile, Array.from(uniqueCorrections.values())));
  }

  function replaceUserData(profile, corrections) {
    return storageCall('set', {
      [PROFILE_KEY]: profile,
      [CORRECTIONS_KEY]: corrections,
      [GENERATION_KEY]: root.crypto.randomUUID()
    });
  }

  root.FormPilotStore = {
    PROFILE_KEY,
    CORRECTIONS_KEY,
    GENERATION_KEY,
    loadProfile,
    hasProfileValue,
    loadProfileState,
    loadUserData,
    saveProfileChanges,
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
