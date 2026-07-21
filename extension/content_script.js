// ── FormPilot Content Script ──
// Scans pages for fillable form fields using platform-specific adapters.
// Communicates with popup via chrome.runtime messages.

// ═══════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * MutationObserver-based element waiter. Resolves when selector matches
 * inside `parent`, or null on timeout. Used for async widget rendering
 * (e.g. Google Forms dropdown options that render after click).
 */
function waitForElement(selector, { timeout = 2000, parent = document } = {}) {
  return new Promise((resolve) => {
    const existing = parent.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const obs = new MutationObserver(() => {
      const el = parent.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(parent === document ? document.body : parent, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function injectHighlightStyles() {
  if (document.getElementById('formpilot-highlight-styles')) return;
  const style = document.createElement('style');
  style.id = 'formpilot-highlight-styles';
  style.textContent = `
    [data-formpilot-highlight] {
      transition: outline 0.3s ease-out, background-color 0.3s ease-out, box-shadow 0.3s ease-out !important;
    }
    [data-formpilot-highlight="high"] {
      outline: 2px solid #2d8a4e !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 8px rgba(45, 138, 78, 0.4) !important;
    }
    [data-formpilot-highlight="medium"] {
      outline: 2px solid #c4930a !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 8px rgba(196, 147, 10, 0.4) !important;
    }
    [data-formpilot-highlight="draft"] {
      outline: 2px solid #2b6cb0 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 8px rgba(43, 108, 176, 0.4) !important;
    }
  `;
  document.head.appendChild(style);
}

let fpSettings = { highlightDuration: 3, autoDraftMode: false };

chrome.storage.sync.get({ highlightDuration: 3, autoDraftMode: false }, (items) => {
  fpSettings = items;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.highlightDuration) fpSettings.highlightDuration = changes.highlightDuration.newValue;
    if (changes.autoDraftMode) fpSettings.autoDraftMode = changes.autoDraftMode.newValue;
  }
});

function applyHighlight(el, level = 'high') {
  if (!el) return;
  el.setAttribute('data-formpilot-highlight', level);
  const ms = fpSettings.highlightDuration * 1000;
  if (ms > 0 && ms <= 10000) { // If > 10s or 0, infinite (don't clear)
    setTimeout(() => {
      el.removeAttribute('data-formpilot-highlight');
    }, ms);
  }
}

// ═══════════════════════════════════════
// PLATFORM DETECTION
// ═══════════════════════════════════════

function detectPlatform() {
  const url = window.location.href;
  if (url.includes('docs.google.com/forms') || url.includes('forms.google.com')) return 'google-forms';
  if (url.includes('forms.office.com') || url.includes('forms.microsoft.com')) return 'ms-forms';
  return 'generic';
}

// ═══════════════════════════════════════
// SECTION CONTEXT — finds nearest heading ancestor to detect
// sections like "Emergency Contact" or "References"
// ═══════════════════════════════════════

function getSectionContext(el) {
  let current = el.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 12) {
    // Check for fieldset legend first (most specific)
    if (current.tagName === 'FIELDSET') {
      const legend = current.querySelector('legend');
      if (legend) return legend.textContent.trim();
    }
    // Check immediate children for headings — don't recurse deeper than one level
    // to avoid grabbing unrelated headings from nested sections
    for (const child of current.children) {
      if (child === el || child.contains(el)) continue;
      const tag = child.tagName;
      if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag) || child.getAttribute('role') === 'heading') {
        const text = child.textContent.trim();
        if (text.length > 0 && text.length < 120) return text;
      }
    }
    current = current.parentElement;
    depth++;
  }
  return '';
}

// ═══════════════════════════════════════
// LABEL RESOLUTION — ordered by reliability
// ═══════════════════════════════════════

function getLabelByFor(el) {
  if (!el.id) return '';
  const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  return label ? label.textContent.trim() : '';
}

function getAriaLabel(el) {
  return (el.getAttribute('aria-label') || '').trim();
}

function getAriaLabelledBy(el) {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  const parts = ids.split(/\s+/).map(id => {
    const ref = document.getElementById(id);
    return ref ? ref.textContent.trim() : '';
  }).filter(Boolean);
  return parts.join(' ');
}

function getWrappingLabel(el) {
  const label = el.closest('label');
  if (!label) return '';
  const clone = label.cloneNode(true);
  clone.querySelectorAll('input, select, textarea').forEach(i => i.remove());
  return clone.textContent.trim();
}

function getProximityLabel(el) {
  let current = el.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 5) {
    for (const child of current.children) {
      if (child === el || child.contains(el)) continue;
      if (['LABEL', 'SPAN', 'DIV', 'P'].includes(child.tagName)) {
        const text = child.textContent.trim();
        // Must have text, not too long, and not contain other inputs
        if (text.length > 0 && text.length < 100 && !child.querySelector('input, select, textarea')) {
          return text;
        }
      }
    }
    current = current.parentElement;
    depth++;
  }
  return '';
}

function getPlaceholder(el) {
  return (el.getAttribute('placeholder') || '').trim();
}

function getSpatialLabel(el) {
  const elRect = el.getBoundingClientRect();
  const elCenter = { x: elRect.left + elRect.width / 2, y: elRect.top + elRect.height / 2 };
  
  let nearestLabel = '';
  let minDist = Infinity;
  
  const candidates = document.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6');
  for (const cand of candidates) {
    if (cand.contains(el) || el.contains(cand)) continue;
    if (!isVisible(cand)) continue;
    
    const text = cand.textContent.trim();
    if (text.length === 0 || text.length > 150) continue;
    if (cand.querySelector('input, select, textarea')) continue;

    const candRect = cand.getBoundingClientRect();
    const candCenter = { x: candRect.left + candRect.width / 2, y: candRect.top + candRect.height / 2 };
    
    const dx = candCenter.x - elCenter.x;
    const dy = candCenter.y - elCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < 200 && dist < minDist) {
      minDist = dist;
      nearestLabel = text;
    }
  }
  return nearestLabel;
}

/** Generic label resolver — tries strategies in priority order */
function resolveLabel(el) {
  return getLabelByFor(el)
    || getAriaLabel(el)
    || getAriaLabelledBy(el)
    || getWrappingLabel(el)
    || getProximityLabel(el)
    || getPlaceholder(el)
    || getSpatialLabel(el)
    || '';
}

/** Google Forms label resolver — uses [data-params] container → [role="heading"] */
function resolveGFormsLabel(el) {
  // Walk up to the question container (marked by data-params)
  let container = el.closest('[data-params]');

  if (!container) {
    // Fallback: walk up looking for any ancestor that has a role="heading" child
    let current = el.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 10) {
      const heading = current.querySelector('[role="heading"]');
      if (heading) return heading.textContent.trim();
      current = current.parentElement;
      depth++;
    }
    return resolveLabel(el);
  }

  const heading = container.querySelector('[role="heading"]');
  if (heading) return heading.textContent.trim();
  return resolveLabel(el);
}

/** MS Forms label resolver — leans on aria attributes first */
function resolveMSFormsLabel(el) {
  return getAriaLabel(el)
    || getAriaLabelledBy(el)
    || resolveLabel(el);
}

// ═══════════════════════════════════════
// OPTION COLLECTION — extracts available options from
// <select>, role="listbox", role="radiogroup", etc.
// ═══════════════════════════════════════

function collectOptions(el) {
  if (el.tagName === 'SELECT') {
    return [...el.options]
      .filter(o => o.value !== '')
      .map(o => ({ value: o.value, text: o.textContent.trim() }));
  }
  if (el.getAttribute('role') === 'listbox') {
    const opts = el.querySelectorAll('[role="option"]');
    return [...opts].map(o => ({
      value: o.getAttribute('data-value') || o.textContent.trim(),
      text: o.textContent.trim(),
    }));
  }
  if (el.getAttribute('role') === 'radiogroup') {
    // Could be <div role="radio"> (Google Forms) or <input type="radio"> (standard)
    const divRadios = el.querySelectorAll('[role="radio"]');
    if (divRadios.length > 0) {
      return [...divRadios].map(r => ({
        value: r.getAttribute('data-value') || r.textContent.trim(),
        text: r.textContent.trim(),
      }));
    }
    const inputRadios = el.querySelectorAll('input[type="radio"]');
    return [...inputRadios].map(r => {
      const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
      return { value: r.value, text: lbl ? lbl.textContent.trim() : r.value };
    });
  }
  return [];
}

// ═══════════════════════════════════════
// BUILD FIELD OBJECT — standardized shape for all adapters
// ═══════════════════════════════════════

function buildFieldObj(el, labelText, isCustom, widgetRole) {
  return {
    element: el,
    id: el.id || '',
    name: el.getAttribute('name') || '',
    type: el.type || el.tagName?.toLowerCase() || widgetRole,
    tagName: el.tagName,
    placeholder: el.getAttribute('placeholder') || '',
    labelText: labelText,
    ariaLabel: getAriaLabel(el),
    isCustomWidget: isCustom,
    widgetRole: widgetRole,
    options: collectOptions(el),
    sectionContext: getSectionContext(el),
  };
}

// ═══════════════════════════════════════
// ADAPTER: GENERIC (standard HTML forms, ATS platforms)
// ═══════════════════════════════════════

const SKIP_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'file', 'date', 'datetime-local', 'month', 'time', 'week']);

const GenericAdapter = {
  collectFields() {
    const fields = [];
    const seen = new WeakSet();

    // Pass 1: standard form elements
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!isVisible(el) || seen.has(el)) continue;
      if (el.tagName === 'INPUT' && SKIP_TYPES.has(el.type)) continue;
      if (el.disabled || el.readOnly) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveLabel(el), false, ''));
    }

    // Pass 2: ARIA role widgets not already captured
    for (const el of document.querySelectorAll('[role="combobox"], [role="listbox"], [role="textbox"], [role="radiogroup"], [contenteditable="true"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
      seen.add(el);
      const role = el.getAttribute('role') || 'contenteditable';
      fields.push(buildFieldObj(el, resolveLabel(el), true, role));
    }

    return fields;
  }
};

// ═══════════════════════════════════════
// ADAPTER: GOOGLE FORMS
// ═══════════════════════════════════════

const GFormsAdapter = {
  collectFields() {
    const fields = [];
    const seen = new WeakSet();

    // 1. Short answer + paragraph (real <input> and <textarea>)
    for (const el of document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea')) {
      if (!isVisible(el) || seen.has(el)) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.type === 'search' || el.getAttribute('role') === 'search') continue;
      // Skip Google's internal toolbar/nav inputs
      if (el.closest('[role="navigation"], [role="banner"], header')) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveGFormsLabel(el), false, ''));
    }

    // 2. Dropdown selects (role="listbox")
    for (const el of document.querySelectorAll('[role="listbox"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveGFormsLabel(el), true, 'listbox'));
    }

    // 3. Multiple choice (role="radiogroup")
    for (const el of document.querySelectorAll('[role="radiogroup"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveGFormsLabel(el), true, 'radiogroup'));
    }

    // 4. Checkboxes (role="group" containing role="checkbox")
    for (const el of document.querySelectorAll('[role="group"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      const cbs = el.querySelectorAll('[role="checkbox"]');
      if (cbs.length === 0) continue;
      seen.add(el);
      const field = buildFieldObj(el, resolveGFormsLabel(el), true, 'checkboxgroup');
      field.options = [...cbs].map(cb => ({
        value: cb.getAttribute('data-value') || cb.textContent.trim(),
        text: cb.textContent.trim(),
      }));
      fields.push(field);
    }

    return fields;
  }
};

// ═══════════════════════════════════════
// ADAPTER: MICROSOFT FORMS
// ═══════════════════════════════════════

const MSFormsAdapter = {
  collectFields() {
    const fields = [];
    const seen = new WeakSet();

    // 1. Text inputs + textareas
    for (const el of document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea')) {
      if (!isVisible(el) || seen.has(el)) continue;
      if (el.disabled || el.readOnly) continue;
      // Skip Microsoft's internal search/nav inputs
      if (el.closest('[role="navigation"], [role="banner"], header, nav')) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), false, ''));
    }

    // 2. Radio groups
    for (const el of document.querySelectorAll('[role="radiogroup"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), true, 'radiogroup'));
    }

    // 3. Combobox / custom dropdowns
    for (const el of document.querySelectorAll('[role="combobox"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), true, 'combobox'));
    }

    // 4. Standard selects (MS Forms occasionally uses real <select>)
    for (const el of document.querySelectorAll('select')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), false, ''));
    }

    // 5. Date inputs
    for (const el of document.querySelectorAll('input[type="date"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), false, ''));
    }

    return fields;
  }
};

// ═══════════════════════════════════════
// MAIN COLLECTOR
// ═══════════════════════════════════════

let cachedFields = [];
let currentPlatform = 'generic';

function getAdapter() {
  switch (currentPlatform) {
    case 'google-forms': return GFormsAdapter;
    case 'ms-forms':     return MSFormsAdapter;
    default:             return GenericAdapter;
  }
}

function collectFields() {
  cachedFields = getAdapter().collectFields();
  return cachedFields;
}

// ═══════════════════════════════════════
// MUTATION OBSERVER — re-scans when new form elements appear (SPA support)
// ═══════════════════════════════════════

const FORM_SELECTORS = 'input, select, textarea, [role="listbox"], [role="radiogroup"], [role="combobox"], [role="textbox"]';

const debouncedRescan = debounce(() => {
  const prev = cachedFields.length;
  collectFields();
  if (cachedFields.length !== prev) {
    console.log(`[FormPilot] Rescan: ${prev} → ${cachedFields.length} fields`);
  }
}, 500);

const domObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.(FORM_SELECTORS) || node.querySelector?.(FORM_SELECTORS)) {
        debouncedRescan();
        return;
      }
    }
  }
});

// ═══════════════════════════════════════
// IFRAME WARNING
// ═══════════════════════════════════════

function checkForIframes() {
  const iframes = document.querySelectorAll('iframe');
  let crossOriginCount = 0;
  for (const iframe of iframes) {
    try { iframe.contentDocument; }
    catch { crossOriginCount++; }
  }
  if (crossOriginCount > 0) {
    console.warn(`[FormPilot] ${crossOriginCount} cross-origin iframe(s) detected. Fields inside them cannot be accessed.`);
  }
}

// ═══════════════════════════════════════
// MATCHING & FILLING LOGIC
// ═══════════════════════════════════════

function getProfileValue(type, profile) {
  if (COMPOSITE_RULES[type]) return COMPOSITE_RULES[type](profile);
  return profile[type] || '';
}

function matchField(field, profile, corrections = {}) {
  const section = field.sectionContext.toLowerCase();
  for (const skip of SKIP_SECTIONS) {
    if (section.includes(skip)) return null;
  }

  // Normalize label
  let label = (field.labelText || field.placeholder || field.ariaLabel || '').toLowerCase();
  label = label.replace(/\xa0/g, ' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim();

  // 1. Check corrections FIRST
  if (corrections && corrections[label] !== undefined) {
    return { type: 'correction', value: corrections[label] };
  }

  // 2. Check signatures
  for (const [sig, type] of Object.entries(FIELD_SIGNATURES)) {
    if (field.name === sig || field.id === sig) {
      return { type, value: getProfileValue(type, profile) };
    }
  }

  // 3. Keyword mapping
  for (const [type, keywords] of Object.entries(FIELD_KEYWORDS)) {
    for (const kw of keywords) {
      if (label === kw || label.includes(` ${kw} `) || label.startsWith(`${kw} `) || label.endsWith(` ${kw}`)) {
        return { type, value: getProfileValue(type, profile) };
      }
    }
  }
  
  return null;
}

function fuzzyMatchOption(options, targetValue, fieldType) {
  targetValue = targetValue.toLowerCase();
  
  // 1. Exact match
  let match = options.find(o => (o.text || '').toLowerCase() === targetValue || (o.value || '').toLowerCase() === targetValue);
  if (match) return match;
  
  // 2. Abbreviation map
  let mappedValue = targetValue;
  if (fieldType && ABBREVIATION_MAPS[fieldType]) {
    for (const [abbr, vars] of Object.entries(ABBREVIATION_MAPS[fieldType])) {
      if (abbr.toLowerCase() === targetValue || vars.some(v => v.toLowerCase() === targetValue)) {
        mappedValue = abbr.toLowerCase(); // standardize to abbreviation for matching
        // Let's try finding the abbreviation in the options
        let abbrMatch = options.find(o => (o.text || '').toLowerCase() === mappedValue || (o.value || '').toLowerCase() === mappedValue);
        if (abbrMatch) return abbrMatch;
        // Or one of its variants
        for(let v of vars) {
           let varMatch = options.find(o => (o.text || '').toLowerCase() === v.toLowerCase() || (o.value || '').toLowerCase() === v.toLowerCase());
           if(varMatch) return varMatch;
        }
      }
    }
  }

  // 3. Includes
  match = options.find(o => (o.text || '').toLowerCase().includes(targetValue) || targetValue.includes((o.text || '').toLowerCase()));
  if (match) return match;
  
  return null;
}

async function fillField(field, matchData) {
  if (!matchData.value) return false;
  const el = field.element;
  const val = matchData.value;
  
  if (!field.isCustomWidget) {
    if (el.tagName === 'SELECT') {
      const matchedOpt = fuzzyMatchOption(field.options, val, matchData.type);
      if (matchedOpt) {
        el.value = matchedOpt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    } else {
      try {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
          setter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch(e) { return false; }
    }
  } else {
    // Custom Widgets
    if (field.widgetRole === 'listbox' || field.widgetRole === 'combobox') {
      el.click(); // open dropdown
      const optionEl = await waitForElement('[role="option"]', { timeout: 1500 });
      if (optionEl) {
        // Re-query all options now that they are rendered
        const opts = [...document.querySelectorAll('[role="option"]')].map(o => ({
          el: o, 
          text: o.textContent.trim(), 
          value: o.getAttribute('data-value') || o.textContent.trim()
        }));
        const matched = fuzzyMatchOption(opts, val, matchData.type);
        if (matched && matched.el) {
          matched.el.click();
          return true;
        } else {
           // close if no match
           el.click();
        }
      }
      return false;
    }
    
    if (field.widgetRole === 'radiogroup' || field.widgetRole === 'checkboxgroup') {
      const matched = fuzzyMatchOption(field.options, val, matchData.type);
      if (matched) {
        // Strategy 1: Find by data-value attribute
        const byDataValue = el.querySelector(`[data-value="${CSS.escape(matched.value)}"]`);
        if (byDataValue) {
          byDataValue.click();
          return true;
        }

        // Strategy 2: Find by value attribute (standard HTML radio/checkbox)
        const byValue = el.querySelector(`[value="${CSS.escape(matched.value)}"]`);
        if (byValue) {
          byValue.click();
          return true;
        }

        // Strategy 3: Match by text content (Google Forms uses divs with role="radio")
        const allClickables = el.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]');
        for (const child of allClickables) {
          const childText = child.textContent.trim().toLowerCase();
          const matchText = matched.text.toLowerCase();
          if (childText === matchText || childText.includes(matchText) || matchText.includes(childText)) {
            child.click();
            return true;
          }
        }

        // Strategy 4: Google Forms wraps radio options in label-like containers
        // Walk siblings to find the clickable area near the matching text
        const allLabels = el.querySelectorAll('[data-value], span, label');
        for (const lbl of allLabels) {
          const lblText = lbl.textContent.trim().toLowerCase();
          if (lblText === matched.text.toLowerCase()) {
            // Click the element itself or its closest clickable ancestor
            const clickTarget = lbl.closest('[role="radio"], [role="checkbox"]') || lbl;
            clickTarget.click();
            return true;
          }
        }
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════
// CORRECTIONS DETECTOR
// ═══════════════════════════════════════

const filledFieldsMap = new WeakMap();

function isSensitiveField(label) {
  const lower = label.toLowerCase();
  for (const kw of SENSITIVE_FIELD_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

function sendCorrection(label, value) {
  chrome.runtime.sendMessage({
    action: 'save_correction',
    field_label: label,
    corrected_value: value
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[FormPilot] Failed to send correction message:', chrome.runtime.lastError);
      return;
    }
    if (response && response.success) {
      console.log(`[FormPilot] Correction saved via proxy: "${label}" -> "${value}"`);
    } else {
      console.error('[FormPilot] Failed to save correction via proxy:', response?.error);
    }
  });
}

function trackFieldCorrections(field, filledValue) {
  const el = field.element;
  
  let label = (field.labelText || field.placeholder || field.ariaLabel || '').toLowerCase();
  label = label.replace(/\xa0/g, ' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  if (!label) return;

  // Never track sensitive fields
  if (isSensitiveField(label)) {
    console.log(`[FormPilot] Skipping sensitive field: "${label}"`);
    return;
  }

  // Skip password-type inputs regardless of label
  if (el.type === 'password') return;

  filledFieldsMap.set(el, { label, filledValue });

  if (el.dataset.formpilotTracked) return;
  el.dataset.formpilotTracked = 'true';

  const handler = () => {
    let currentValue = '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      currentValue = el.value;
    } else {
      if (el.getAttribute('role') === 'listbox' || el.getAttribute('role') === 'combobox') {
        currentValue = el.getAttribute('data-value') || el.textContent.trim();
      } else if (el.getAttribute('role') === 'radiogroup' || el.getAttribute('role') === 'group') {
        const checked = el.querySelector('[aria-checked="true"], input[type="radio"]:checked, input[type="checkbox"]:checked');
        currentValue = checked ? (checked.getAttribute('data-value') || checked.value || checked.textContent.trim()) : '';
      }
    }

    const tracked = filledFieldsMap.get(el);
    if (tracked && currentValue && currentValue !== tracked.filledValue) {
      tracked.filledValue = currentValue;
      filledFieldsMap.set(el, tracked);
      sendCorrection(tracked.label, currentValue);
    }
  };

  el.addEventListener('blur', handler);
  el.addEventListener('change', handler);
  // For custom widgets (radio/checkbox divs), also listen for click since blur/change don't fire
  if (el.getAttribute('role') === 'radiogroup' || el.getAttribute('role') === 'group') {
    el.addEventListener('click', handler);
  }
}

// ═══════════════════════════════════════
// MESSAGE HANDLER — responds to popup actions
// ═══════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scan') {
    const fields = collectFields();
    sendResponse({
      fieldCount: fields.length,
      platform: currentPlatform,
      fields: fields.map(f => ({
        labelText: f.labelText,
        type: f.type,
        id: f.id,
        name: f.name,
        isCustomWidget: f.isCustomWidget,
        sectionContext: f.sectionContext,
        optionCount: f.options.length,
      })),
    });
    return true;
  }

  if (message.action === 'autofill') {
    if (!message.profile) {
      sendResponse({ success: false, error: 'No profile data received.' });
      return true;
    }

    const fields = collectFields();
    let matchedCount = 0;
    const corrections = message.corrections || {};

    (async () => {
      const unmatchedFields = [];
      const unmatchedLabels = [];

      // 1. Heuristic & Correction Phase
      for (const field of fields) {
        const match = matchField(field, message.profile, corrections);
        if (match) {
           const success = await fillField(field, match);
           if (success) {
             matchedCount++;
             trackFieldCorrections(field, match.value);
             applyHighlight(field.element, 'high');
           }
        } else {
           // Skip sensitive fields from LLM fallback
           let label = (field.labelText || field.placeholder || field.ariaLabel || '').trim();
           if (label && !isSensitiveField(label) && field.element.type !== 'password') {
             unmatchedFields.push(field);
             unmatchedLabels.push(label);
           }
        }
      }

      // 2. LLM Fallback Phase
      if (unmatchedLabels.length > 0) {
        console.log(`[FormPilot] Requesting LLM mapping for ${unmatchedLabels.length} fields:`, unmatchedLabels);
        try {
          const llmResp = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'match_fields', unmatched_labels: unmatchedLabels }, resolve);
          });
          
          if (llmResp && llmResp.success && llmResp.mappings) {
            console.log('[FormPilot] LLM Mappings Result:', llmResp.mappings);
            const mappings = llmResp.mappings;
            
            for (const field of unmatchedFields) {
              let label = (field.labelText || field.placeholder || field.ariaLabel || '').trim();
              const mappedKey = mappings[label];
              
              if (mappedKey === null || mappedKey === 'null') {
                 if (fpSettings.autoDraftMode) {
                   console.log(`[FormPilot] Auto-drafting field "${label}"...`);
                   try {
                     chrome.runtime.sendMessage({
                        action: 'draft_answer',
                        questions: [label],
                        user_context: '',
                        use_profile: true
                     }, async (resp) => {
                        if (resp && resp.success && resp.drafts && resp.drafts[label]) {
                          const draftedText = resp.drafts[label];
                          await fillField(field, { value: draftedText, type: 'llm' });
                          applyHighlight(field.element, 'draft');
                        }
                     });
                   } catch (e) {
                     console.error('[FormPilot] Auto-draft failed for', label, e);
                   }
                 } else {
                   console.log(`[FormPilot] Skipping field "${label}" as it was mapped to null (Requires Phase 7 drafting).`);
                   injectSparkleIcon(field, label);
                 }
                 continue;
              }

              if (mappedKey) {
                let valueToFill = '';
                if (mappedKey.startsWith('profile.') && message.profile) {
                  const key = mappedKey.split('.')[1];
                  valueToFill = message.profile[key];
                  console.log(`[FormPilot] Mapping "${label}" -> profile.${key} = "${valueToFill}"`);
                } else if (mappedKey.startsWith('resume.') && message.resume) {
                  const key = mappedKey.split('.')[1];
                  const resumeVals = message.resume[key];
                  if (Array.isArray(resumeVals)) {
                    valueToFill = resumeVals.join('\n'); // Draft long answer
                  } else {
                    valueToFill = resumeVals;
                  }
                  console.log(`[FormPilot] Mapping "${label}" -> resume.${key} = [Extracted Content length: ${valueToFill ? valueToFill.length : 0}]`);
                }
                
                if (valueToFill) {
                   const match = { value: valueToFill, type: 'llm' };
                   const success = await fillField(field, match);
                   if (success) {
                     matchedCount++;
                     trackFieldCorrections(field, valueToFill);
                     applyHighlight(field.element, mappedKey.startsWith('resume.') ? 'draft' : 'medium');
                     console.log(`[FormPilot] Successfully filled "${label}" using LLM Fallback.`);
                   } else {
                     console.warn(`[FormPilot] Failed to fill "${label}" in the DOM.`);
                   }
                } else {
                   console.log(`[FormPilot] No data found in profile/resume for key: ${mappedKey}`);
                }
              }
            }
          } else {
             console.error('[FormPilot] Invalid response from match_fields proxy:', llmResp);
          }
        } catch (e) {
          console.error('[FormPilot] LLM Fallback failed:', e);
        }
      }

      // Track UNFILLED fields too — learn from manual user input
      for (const field of fields) {
        if (!filledFieldsMap.has(field.element)) {
          trackFieldCorrections(field, '');
        }
      }
      
      sendResponse({
        success: true,
        matched: matchedCount,
        needsReview: fields.length - matchedCount
      });
    })();
    return true; // async response
  }

  if (message.action === 'scroll_to_review') {
    const el = document.querySelector('[data-formpilot-highlight="medium"], [data-formpilot-highlight="draft"], .formpilot-sparkle');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Blink effect
      const origOutline = el.style.outline;
      el.style.outline = '3px solid #ae6a97';
      setTimeout(() => el.style.outline = origOutline, 1500);
    }
    sendResponse({ success: true });
    return true;
  }

  return false;
});

let currentDraftField = null;

function createDraftDialog() {
  if (document.getElementById('formpilot-draft-dialog')) return;
  
  const dialog = document.createElement('div');
  dialog.id = 'formpilot-draft-dialog';
  dialog.style.position = 'absolute';
  dialog.style.zIndex = '10000';
  dialog.style.display = 'none';
  dialog.style.backgroundColor = '#f8f0ea';
  dialog.style.border = '2px solid #ae6a97';
  dialog.style.borderRadius = '8px';
  dialog.style.padding = '12px';
  dialog.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  dialog.style.width = '300px';
  dialog.style.fontFamily = 'sans-serif';
  
  dialog.innerHTML = `
    <div style="font-weight: bold; color: #ae6a97; margin-bottom: 8px; font-size: 14px;" id="formpilot-draft-label">Question</div>
    <textarea id="formpilot-draft-context" style="width: 100%; height: 60px; border: 1px solid #eca8bb; border-radius: 4px; padding: 4px; font-size: 13px; margin-bottom: 8px; box-sizing: border-box;" placeholder="e.g. I was preparing for JEE exams, add this in formal tone in 2-3 lines"></textarea>
    <label style="display: flex; align-items: center; font-size: 12px; margin-bottom: 8px; color: #333; cursor: pointer;">
      <input type="checkbox" id="formpilot-draft-profile" checked style="margin-right: 4px;"> Include my profile/resume context
    </label>
    <div style="display: flex; justify-content: flex-end; gap: 8px;">
      <button id="formpilot-draft-cancel" style="background: transparent; border: none; color: #666; cursor: pointer; font-size: 13px;">Cancel</button>
      <button id="formpilot-draft-submit" style="background: #ae6a97; color: white; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 13px; font-weight: bold;">Draft with AI</button>
    </div>
  `;
  document.body.appendChild(dialog);
  
  document.getElementById('formpilot-draft-cancel').addEventListener('click', (e) => {
    e.preventDefault();
    dialog.style.display = 'none';
  });
  
  document.getElementById('formpilot-draft-submit').addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = e.target;
    const context = document.getElementById('formpilot-draft-context').value;
    const useProfile = document.getElementById('formpilot-draft-profile').checked;
    const label = document.getElementById('formpilot-draft-label').textContent;
    
    btn.textContent = 'Drafting...';
    btn.disabled = true;
    
    try {
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          action: 'draft_answer',
          questions: [label],
          user_context: context,
          use_profile: useProfile
        }, resolve);
      });
      
      if (resp && resp.success && resp.drafts && resp.drafts[label]) {
        const draftedText = resp.drafts[label];
        if (currentDraftField) {
           await fillField(currentDraftField, { value: draftedText, type: 'llm' });
           applyHighlight(currentDraftField.element, 'draft');
           dialog.style.display = 'none';
           const sparkles = document.querySelectorAll('.formpilot-sparkle');
           sparkles.forEach(s => {
             if (s.fieldRef === currentDraftField) s.style.display = 'none';
           });
        }
      } else {
        alert('FormPilot: Failed to draft answer.');
      }
    } catch (err) {
      console.error(err);
      alert('FormPilot: Error drafting answer.');
    } finally {
      btn.textContent = 'Draft with AI';
      btn.disabled = false;
    }
  });
}

function injectSparkleIcon(field, label) {
  if (field.element.dataset.fpSparkle) return;
  field.element.dataset.fpSparkle = 'true';
  
  const rect = field.element.getBoundingClientRect();
  const sparkle = document.createElement('div');
  sparkle.className = 'formpilot-sparkle';
  sparkle.textContent = '✨';
  sparkle.style.position = 'absolute';
  sparkle.style.left = (rect.right - 24 + window.scrollX) + 'px';
  sparkle.style.top = (rect.top + window.scrollY + (rect.height / 2) - 10) + 'px';
  sparkle.style.cursor = 'pointer';
  sparkle.style.zIndex = '9999';
  sparkle.style.fontSize = '16px';
  sparkle.style.transition = 'transform 0.2s';
  sparkle.fieldRef = field; 
  
  sparkle.addEventListener('mouseenter', () => sparkle.style.transform = 'scale(1.2)');
  sparkle.addEventListener('mouseleave', () => sparkle.style.transform = 'scale(1)');
  
  sparkle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    currentDraftField = field;
    const dialog = document.getElementById('formpilot-draft-dialog');
    document.getElementById('formpilot-draft-label').textContent = label;
    document.getElementById('formpilot-draft-context').value = '';
    
    const sRect = sparkle.getBoundingClientRect();
    // Position dialog relative to sparkle, ensure it doesn't go off left screen
    let dLeft = sRect.left + window.scrollX - 280;
    if (dLeft < 10) dLeft = 10;
    dialog.style.left = dLeft + 'px';
    dialog.style.top = (sRect.bottom + window.scrollY + 5) + 'px';
    dialog.style.display = 'block';
  });
  
  document.body.appendChild(sparkle);
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

(function init() {
  currentPlatform = detectPlatform();
  console.log(`[FormPilot] Platform: ${currentPlatform}`);
  injectHighlightStyles();
  createDraftDialog();

  collectFields();
  console.log(`[FormPilot] Initial scan: ${cachedFields.length} fields`);
  cachedFields.forEach((f, i) => {
    console.log(`[FormPilot]  ${i + 1}. "${f.labelText}" type=${f.type} id="${f.id}" name="${f.name}" section="${f.sectionContext}" options=${f.options.length}`);
  });

  domObserver.observe(document.body, { childList: true, subtree: true });
  checkForIframes();
})();
