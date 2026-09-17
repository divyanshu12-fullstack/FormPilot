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
    .formpilot-sparkle {
      position: fixed !important;
      width: 22px !important;
      height: 22px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-size: 15px !important;
      line-height: 1 !important;
      cursor: pointer !important;
      z-index: 2147483000 !important;
      user-select: none !important;
      background: #f8f0ea !important;
      border: 1px solid #ae6a97 !important;
      border-radius: 50% !important;
      box-shadow: 0 1px 4px rgba(86, 29, 70, 0.25) !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    .formpilot-sparkle:hover, .formpilot-sparkle:focus-visible {
      transform: scale(1.15) !important;
      outline: 2px solid #ae6a97 !important;
      outline-offset: 1px !important;
    }
    @media (prefers-reduced-motion: reduce) {
      .formpilot-sparkle { transition: none !important; }
    }
    #formpilot-draft-dialog {
      position: fixed !important;
      z-index: 2147483001 !important;
      display: none;
      background-color: #f8f0ea !important;
      border: 2px solid #ae6a97 !important;
      border-radius: 8px !important;
      padding: 12px !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;
      width: min(320px, 90vw) !important;
      max-height: 80vh !important;
      overflow: auto !important;
      font-family: sans-serif !important;
      box-sizing: border-box !important;
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
      // Keep placeholder-valued options too (some ATS use value="0"/text-only);
      // fuzzyMatchOption prefers exact text match anyway. Only drop fully empty rows.
      .filter(o => (o.value !== '' || (o.textContent || '').trim() !== ''))
      .map(o => ({ value: o.value || o.textContent.trim(), text: o.textContent.trim() }));
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
      let lbl = null;
      if (r.id) {
        try { lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`); } catch (e) { lbl = null; }
      }
      // Fallback: label wrapping without `for` (missed before).
      if (!lbl && r.closest) lbl = r.closest('label');
      return { value: r.value || (lbl ? lbl.textContent.trim() : ''), text: lbl ? lbl.textContent.trim() : (r.value || '') };
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

const SKIP_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'file']);

function isDateField(field) {
  if (!field || !field.element) return false;
  const el = field.element;
  const t = (el.type || '').toLowerCase();
  if (['date', 'datetime-local', 'month', 'time', 'week'].includes(t)) return true;
  if (el.classList && (el.classList.contains('hasDatepicker') || el.classList.contains('datepicker'))) return true;
  return false;
}

// Native date/time inputs (browser calendar UI) — never auto-fill or sparkle.
// Text inputs with a JS datepicker class ARE allowed through to LLM/sparkle
// for manual assist, since they accept typed text.
function isNativeDateInput(field) {
  if (!field || !field.element) return false;
  const t = ((field.element.type || '') + '').toLowerCase();
  return ['date', 'datetime-local', 'month', 'time', 'week'].includes(t);
}

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

const FORM_SELECTORS = 'input, select, textarea, [role="listbox"], [role="radiogroup"], [role="combobox"], [role="textbox"], [role="group"], [role="checkbox"], [contenteditable="true"]';

const debouncedRescan = debounce(() => {
  const prev = cachedFields.length;
  collectFields();
  if (cachedFields.length !== prev) {
    console.log(`[FormPilot] Rescan: ${prev} → ${cachedFields.length} fields`);
    chrome.runtime.sendMessage({ action: 'forms_detected', count: cachedFields.length }).catch(() => {});
  }
  if (typeof pruneDetachedSparkles === 'function') pruneDetachedSparkles();
  if (typeof scheduleSparkleReposition === 'function') scheduleSparkleReposition();
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

// ── Relaxed normalization: single helper shared by match + corrections ──
// Lowercases, strips punctuation that breaks token-boundary checks
// ("First Name:", "Email (Work)", "City/Town", "Phone-number" → plain words).
function normalizeLabel(raw) {
  let s = (raw || '').toLowerCase();
  s = s.replace(/\xa0/g, ' ');
  // Turn common separators/punctuation into spaces so "city/town",
  // "phone-number", "email (work)", "first_name" all tokenize cleanly.
  s = s.replace(/[*_:;,()\/\\\-_.?!"'&|+@#%[\]{}<>]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function normalizeSig(raw) {
  return normalizeLabel(raw).replace(/\s+/g, '');
}

// Token-boundary check that avoids substring false positives
// (e.g. "other" should not match inside "mother"/"another").
function labelHasToken(label, token) {
  if (!label || !token) return false;
  if (label === token) return true;
  return label.includes(` ${token} `) || label.startsWith(`${token} `) || label.endsWith(` ${token}`);
}

// True other-person fields: always block. Everything else is soft and
// requires section context too (see matchField below).
const HARD_NEGATIVE_LABEL_KEYWORDS = [
  'father', 'mother', 'spouse', 'husband', 'wife',
  'guardian', 'nominee', 'emergency', 'next of kin'
];

const SOFT_NEGATIVE_LABEL_KEYWORDS = [
  'reference', 'referral', 'supervisor', 'manager',
  'secondary', 'alternate', 'other', 'previous', 'former',
  'parent', 'family'
];

// Back-compat alias (was a single hard list before the relax pass).
const NEGATIVE_LABEL_KEYWORDS = [
  ...HARD_NEGATIVE_LABEL_KEYWORDS,
  ...SOFT_NEGATIVE_LABEL_KEYWORDS
];

function sectionHasToken(section, token) {
  return labelHasToken(section, token);
}

function matchField(field, profile, corrections = {}) {
  const section = normalizeLabel(field.sectionContext || '');
  // Section skip now uses token match (not raw substring) to avoid
  // e.g. "References" blocking the applicant's own "Reference Number".
  for (const skip of SKIP_SECTIONS) {
    if (sectionHasToken(section, normalizeLabel(skip))) return null;
  }

  // Normalize label (shared helper — same as corrections tracker)
  const label = normalizeLabel(field.labelText || field.placeholder || field.ariaLabel || '');

  // Hard block: fields that belong to someone else, regardless of section.
  for (const neg of HARD_NEGATIVE_LABEL_KEYWORDS) {
    if (labelHasToken(label, neg)) return null;
  }
  // Soft block: only reject when the section ALSO looks like another
  // person's section (e.g. "Emergency Contact" + "Phone"). A bare
  // "Reference Number" or "Secondary Email" in a normal section fills.
  for (const neg of SOFT_NEGATIVE_LABEL_KEYWORDS) {
    if (!labelHasToken(label, neg)) continue;
    let sectionConfirms = false;
    for (const skip of SKIP_SECTIONS) {
      if (sectionHasToken(section, normalizeLabel(skip))) { sectionConfirms = true; break; }
    }
    if (sectionConfirms) return null;
    // Also block classic "X's Y" other-person phrasing even without section,
    // e.g. "father name", "spouse phone", "manager email".
    // Soft words alone ("other", "previous") do NOT block here.
    let otherPersonCue = false;
    for (const hard of HARD_NEGATIVE_LABEL_KEYWORDS) {
      if (labelHasToken(label, hard)) { otherPersonCue = true; break; }
    }
    if (otherPersonCue) return null;
  }

  // 1. Check corrections FIRST (exact + normalized fallback)
  if (corrections) {
    if (corrections[label] !== undefined) {
      return { type: 'correction', value: corrections[label] };
    }
    // Fallback: corrections saved with slightly different punctuation/
    // casing ("Email Address *" vs "email address") still hit.
    for (const [savedLabel, savedValue] of Object.entries(corrections)) {
      if (normalizeLabel(savedLabel) === label) {
        return { type: 'correction', value: savedValue };
      }
    }
  }

  // 2. Check signatures (case-insensitive + punctuation-insensitive)
  const normName = normalizeSig(field.name || '');
  const normId = normalizeSig(field.id || '');
  for (const [sig, type] of Object.entries(FIELD_SIGNATURES)) {
    const normSig = normalizeSig(sig);
    if (!normSig) continue;
    if (normName === normSig || normId === normSig
      || (normName && normName.includes(normSig))
      || (normId && normId.includes(normSig))) {
      const value = getProfileValue(type, profile);
      // Empty profile value → treat as miss so LLM/sparkle can try,
      // instead of a silent fillField failure.
      if (value === '' || value === null || value === undefined) return null;
      return { type, value };
    }
  }

  // 3. Keyword mapping (label + keywords both normalized, so punctuation
  // no longer breaks matches; still token-boundary to limit false positives)
  for (const [type, keywords] of Object.entries(FIELD_KEYWORDS)) {
    for (const rawKw of keywords) {
      const kw = normalizeLabel(rawKw);
      if (!kw) continue;
      if (labelHasToken(label, kw)) {
        const value = getProfileValue(type, profile);
        if (value === '' || value === null || value === undefined) return null;
        return { type, value };
      }
    }
  }
  
  return null;
}

function fuzzyMatchOption(options, targetValue, fieldType) {
  targetValue = (targetValue || '').toLowerCase().trim();
  if (!targetValue) return null;
  
  // 1. Exact match
  let match = options.find(o => (o.text || '').toLowerCase().trim() === targetValue || (o.value || '').toLowerCase().trim() === targetValue);
  if (match) return match;
  
  // 2. Abbreviation map (keys are lowercase field types — see constants.js)
  const abbrMap = fieldType ? ABBREVIATION_MAPS[fieldType] || ABBREVIATION_MAPS[String(fieldType).toLowerCase()] : null;
  if (abbrMap) {
    // Sort entries so longer/specific variants match first. In particular
    // "Female" must be tried before "Male" — otherwise "male".includes
    // style fallback matches the wrong option.
    const entries = Object.entries(abbrMap).sort((a, b) => {
      const aLen = Math.max(a[0].length, ...a[1].map(v => v.length));
      const bLen = Math.max(b[0].length, ...b[1].map(v => v.length));
      return bLen - aLen;
    });
    for (const [abbr, vars] of entries) {
      if (abbr.toLowerCase() === targetValue || vars.some(v => v.toLowerCase() === targetValue)) {
        const mappedValue = abbr.toLowerCase(); // standardize to abbreviation for matching
        // Let's try finding the abbreviation in the options
        let abbrMatch = options.find(o => (o.text || '').toLowerCase().trim() === mappedValue || (o.value || '').toLowerCase().trim() === mappedValue);
        if (abbrMatch) return abbrMatch;
        // Or one of its variants
        for (let v of vars) {
           let varMatch = options.find(o => (o.text || '').toLowerCase().trim() === v.toLowerCase() || (o.value || '').toLowerCase().trim() === v.toLowerCase());
           if (varMatch) return varMatch;
        }
      }
    }
  }

  // 3. Includes — exact-substring only when one side is clearly longer,
  // to avoid "M" matching "Female"/"Male"/"India" style false positives.
  // Require the shorter side to be at least 3 chars.
  match = options.find(o => {
    const t = (o.text || '').toLowerCase().trim();
    if (!t || t.length < 3 || targetValue.length < 3) return false;
    // Prefer word-boundary includes over raw substring.
    if (t === targetValue) return true;
    if (t.includes(targetValue) || targetValue.includes(t)) {
      // Guard: single-token gender edge ("male" vs "female").
      if ((targetValue === 'male' && t === 'female') || (targetValue === 'female' && t === 'male')) return false;
      return true;
    }
    return false;
  });
  if (match) return match;
  
  return null;
}

async function fillField(field, matchData) {
  if (!matchData || matchData.value === '' || matchData.value === null || matchData.value === undefined) return false;
  // Treat whitespace-only as empty (prevents silent "match but no fill").
  if (typeof matchData.value === 'string' && matchData.value.trim() === '') return false;
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
      // contenteditable / role=textbox widgets have no .value setter
      if (el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('contenteditable') === 'true') {
        try {
          el.focus();
          el.textContent = val;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch (e) { return false; }
      }
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
      
      // Scope option search to the dropdown's popup container
      const ownedId = el.getAttribute('aria-owns') || el.getAttribute('aria-controls');
      const popupContainer = ownedId ? document.getElementById(ownedId) : null;
      const searchRoot = popupContainer || document;
      
      const optionEl = await waitForElement('[role="option"]', { timeout: 1500, parent: searchRoot });
      if (optionEl) {
        // Re-query options scoped to the popup container (or document as fallback)
        const opts = [...searchRoot.querySelectorAll('[role="option"]')].map(o => ({
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
        // Helper: check if an element is already selected/checked
        const isAlreadySelected = (target) => {
          if (!target) return false;
          if (target.checked) return true;
          if (target.getAttribute('aria-checked') === 'true') return true;
          return false;
        };

        // Strategy 1: Find by data-value attribute
        const byDataValue = el.querySelector(`[data-value="${CSS.escape(matched.value)}"]`);
        if (byDataValue) {
          if (!isAlreadySelected(byDataValue)) byDataValue.click();
          return true;
        }

        // Strategy 2: Find by value attribute (standard HTML radio/checkbox)
        const byValue = el.querySelector(`[value="${CSS.escape(matched.value)}"]`);
        if (byValue) {
          if (!isAlreadySelected(byValue)) byValue.click();
          return true;
        }

        // Strategy 3: Match by text content (Google Forms uses divs with role="radio")
        const allClickables = el.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]');
        for (const child of allClickables) {
          const childText = child.textContent.trim().toLowerCase();
          const matchText = matched.text.toLowerCase();
          if (childText === matchText || childText.includes(matchText) || matchText.includes(childText)) {
            if (!isAlreadySelected(child)) child.click();
            return true;
          }
        }

        // Strategy 4: Google Forms wraps radio options in label-like containers
        const allLabels = el.querySelectorAll('[data-value], span, label');
        for (const lbl of allLabels) {
          const lblText = lbl.textContent.trim().toLowerCase();
          if (lblText === matched.text.toLowerCase()) {
            const clickTarget = lbl.closest('[role="radio"], [role="checkbox"]') || lbl;
            if (!isAlreadySelected(clickTarget)) clickTarget.click();
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

let isAutoFilling = false;
const filledFieldsMap = new WeakMap();

function isSensitiveField(label) {
  const lower = normalizeLabel(label);
  for (const rawKw of SENSITIVE_FIELD_KEYWORDS) {
    const kw = normalizeLabel(rawKw);
    if (!kw) continue;
    // Fail-closed: substring on normalized text (catches "cardno",
    // "card-number", "security_code" variants). Deliberately stricter
    // than the token match used for soft negative guards.
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
  
  const label = normalizeLabel(field.labelText || field.placeholder || field.ariaLabel || '');
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
    if (isAutoFilling) return; // Ignore events triggered by autofill itself
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
    if (tracked && currentValue !== tracked.filledValue) {
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
    const resume = message.resume || {};

    (async () => {
      isAutoFilling = true;
      const unmatchedFields = [];
      const unmatchedLabels = [];

       // 1. Heuristic & Correction Phase
      for (const field of fields) {
        const match = matchField(field, message.profile, corrections);
        if (match) {
           // Skip fields that already have user-entered values, unless this is a correction
           const existingValue = field.element.value || field.element.textContent?.trim() || '';
           if (existingValue && match.type !== 'correction' && !filledFieldsMap.has(field.element)) {
             continue; // User already typed something here, don't overwrite
           }
           const success = await fillField(field, match);
           if (success) {
             matchedCount++;
             trackFieldCorrections(field, match.value);
             applyHighlight(field.element, 'high');
           }
        } else {
           // Skip sensitive fields and native date inputs from LLM fallback.
           // Text inputs with a JS datepicker class still go through so the
           // user gets manual sparkle assist.
           let label = (field.labelText || field.placeholder || field.ariaLabel || '').trim();
           if (label && !isSensitiveField(label) && field.element.type !== 'password' && !isNativeDateInput(field)) {
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
              const label = (field.labelText || field.placeholder || field.ariaLabel || '').trim();
              // LLM often drifts on case/whitespace/punctuation
              // ("Email Address *" vs "email address") — normalize both sides.
              let mappedKey;
              if (Object.prototype.hasOwnProperty.call(mappings, label)) {
                mappedKey = mappings[label];
              } else {
                const normLabel = normalizeLabel(label);
                for (const [rawKey, val] of Object.entries(mappings)) {
                  if (normalizeLabel(rawKey) === normLabel) { mappedKey = val; break; }
                }
              }
              
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
                         if (resp && resp.success && resp.drafts) {
                           const draftedText = resp.drafts[label]
                             ?? resp.drafts[Object.keys(resp.drafts).find(k => normalizeLabel(k) === normalizeLabel(label))];
                           if (!draftedText) return;
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
              } else if (mappedKey === undefined) {
                // LLM returned no entry for this label (key drift beyond
                // normalization, or empty mappings on error) — still offer
                // manual assist instead of silently dropping the field.
                if (!fpSettings.autoDraftMode) injectSparkleIcon(field, label);
              }
            }
          } else {
             const errMsg = (llmResp && llmResp.error) ? llmResp.error : JSON.stringify(llmResp);
             console.error('[FormPilot] Failed to get LLM mappings:', errMsg);
             // Offline/LLM-down: every unmatched field still gets manual assist.
             if (!fpSettings.autoDraftMode) {
               for (const field of unmatchedFields) {
                 const lbl = (field.labelText || field.placeholder || field.ariaLabel || '').trim();
                 if (lbl) injectSparkleIcon(field, lbl);
               }
             }
          }
        } catch (e) {
          console.error('[FormPilot] LLM Fallback failed:', e);
          if (!fpSettings.autoDraftMode) {
            for (const field of unmatchedFields) {
              const lbl = (field.labelText || field.placeholder || field.ariaLabel || '').trim();
              if (lbl) injectSparkleIcon(field, lbl);
            }
          }
        }
      }

      // Track UNFILLED fields too — learn from manual user input
      for (const field of fields) {
        if (!filledFieldsMap.has(field.element)) {
          trackFieldCorrections(field, '');
        }
      }
      
      isAutoFilling = false;
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
      // Sparkles are position:fixed — scroll their anchor field instead.
      const target = (el.classList && el.classList.contains('formpilot-sparkle') && el.fieldRef && el.fieldRef.element) ? el.fieldRef.element : el;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Blink effect (skip sparkles — their outline is part of the badge style)
      if (!el.classList || !el.classList.contains('formpilot-sparkle')) {
        const origOutline = el.style.outline;
        el.style.outline = '3px solid #ae6a97';
        setTimeout(() => el.style.outline = origOutline, 1500);
      }
    }
    sendResponse({ success: true });
    return true;
  }

  return false;
});

let currentDraftField = null;
let currentSparkleEl = null;
const sparkleRegistry = []; // { sparkle, field, label, anchor }
let sparkleReposScheduled = false;

function getSparkleAnchor(field) {
  const el = field.element;
  if (!el) return null;
  // For grouped custom widgets, anchor to the first visible inner control
  // instead of the whole group container (fixes vertical mis-centering).
  if (field.isCustomWidget && (field.widgetRole === 'radiogroup' || field.widgetRole === 'checkboxgroup' || field.widgetRole === 'listbox' || field.widgetRole === 'combobox')) {
    const inner = el.querySelector('input:not([type="hidden"]), [role="radio"], [role="checkbox"], [role="option"], [role="textbox"]');
    if (inner && isVisible(inner)) return inner;
  }
  return el;
}

function positionSparkle(entry) {
  const { sparkle, field } = entry;
  const anchor = getSparkleAnchor(field);
  if (!anchor || !document.contains(anchor) || !isVisible(anchor)) {
    sparkle.style.display = 'none';
    return;
  }
  if (sparkle.dataset.fpDone === 'true') return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { sparkle.style.display = 'none'; return; }
  sparkle.style.display = 'flex';
  // Wide text-like fields: badge sits inside the right edge (with padding
  // reserved on the field so text isn't covered). Narrow/small widgets or
  // custom groups: badge floats just outside to avoid covering arrows/boxes.
  const isTextLike = !field.isCustomWidget && (anchor.tagName === 'INPUT' || anchor.tagName === 'TEXTAREA' || anchor.tagName === 'SELECT');
  if (isTextLike && rect.width > 80) {
    sparkle.style.left = (rect.right - 28) + 'px';
    sparkle.style.top = (rect.top + rect.height / 2 - 11) + 'px';
  } else {
    sparkle.style.left = (rect.right + 4) + 'px';
    sparkle.style.top = (rect.top + rect.height / 2 - 11) + 'px';
  }
}

function scheduleSparkleReposition() {
  if (sparkleReposScheduled) return;
  sparkleReposScheduled = true;
  requestAnimationFrame(() => {
    sparkleReposScheduled = false;
    for (const entry of sparkleRegistry) positionSparkle(entry);
    // Keep open dialog pinned to its sparkle; close if anchor is gone.
    const dialog = document.getElementById('formpilot-draft-dialog');
    if (dialog && dialog.style.display === 'block' && currentSparkleEl) {
      if (!document.contains(currentSparkleEl) || currentSparkleEl.style.display === 'none') {
        dialog.style.display = 'none';
      } else {
        positionDraftDialog(currentSparkleEl);
      }
    }
  });
}

function pruneDetachedSparkles() {
  for (let i = sparkleRegistry.length - 1; i >= 0; i--) {
    const entry = sparkleRegistry[i];
    const anchor = entry.field.element;
    if (!anchor || !document.contains(anchor)) {
      entry.sparkle.remove();
      sparkleRegistry.splice(i, 1);
    }
  }
}

function positionDraftDialog(sparkleEl) {
  const dialog = document.getElementById('formpilot-draft-dialog');
  if (!dialog || !sparkleEl) return;
  const sRect = sparkleEl.getBoundingClientRect();
  const dialogWidth = Math.min(320, Math.floor(window.innerWidth * 0.9));
  const estHeight = dialog.offsetHeight > 10 ? dialog.offsetHeight : 230;
  let dLeft = Math.round(sRect.left - dialogWidth + 20);
  dLeft = Math.max(10, Math.min(dLeft, window.innerWidth - dialogWidth - 10));
  let dTop = Math.round(sRect.bottom + 6);
  if (dTop + estHeight > window.innerHeight - 10) {
    dTop = Math.round(sRect.top - estHeight - 6);
  }
  if (dTop < 10) dTop = 10;
  dialog.style.left = dLeft + 'px';
  dialog.style.top = dTop + 'px';
}

function openDraftDialog(field, label, sparkleEl) {
  currentDraftField = field;
  currentSparkleEl = sparkleEl || null;
  const dialog = document.getElementById('formpilot-draft-dialog');
  if (!dialog) return;
  document.getElementById('formpilot-draft-label').textContent = label;
  document.getElementById('formpilot-draft-context').value = '';
  dialog.style.display = 'block';
  positionDraftDialog(sparkleEl);
  const ta = document.getElementById('formpilot-draft-context');
  if (ta) ta.focus();
}

function closeDraftDialog(returnFocus = true) {
  const dialog = document.getElementById('formpilot-draft-dialog');
  if (dialog) dialog.style.display = 'none';
  if (returnFocus && currentSparkleEl && document.contains(currentSparkleEl)) {
    currentSparkleEl.focus({ preventScroll: true });
  }
  currentDraftField = null;
  currentSparkleEl = null;
}

function createDraftDialog() {
  if (document.getElementById('formpilot-draft-dialog')) return;
  
  const dialog = document.createElement('div');
  dialog.id = 'formpilot-draft-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'false');
  dialog.setAttribute('aria-labelledby', 'formpilot-draft-label');
  
  dialog.innerHTML = `
    <div style="font-weight: bold; color: #ae6a97; margin-bottom: 8px; font-size: 14px;" id="formpilot-draft-label">Question</div>
    <textarea id="formpilot-draft-context" aria-label="Guidance for AI draft" style="width: 100%; height: 60px; border: 1px solid #eca8bb; border-radius: 4px; padding: 4px; font-size: 13px; margin-bottom: 8px; box-sizing: border-box;" placeholder="e.g. I was preparing for JEE exams, add this in formal tone in 2-3 lines"></textarea>
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
    closeDraftDialog(true);
  });

  document.addEventListener('keydown', (e) => {
    const dlg = document.getElementById('formpilot-draft-dialog');
    if (dlg && dlg.style.display === 'block' && e.key === 'Escape') {
      e.stopPropagation();
      closeDraftDialog(true);
    }
  });

  // Click-outside dismisses (but not the sparkle click that opened it).
  document.addEventListener('pointerdown', (e) => {
    const dlg = document.getElementById('formpilot-draft-dialog');
    if (!dlg || dlg.style.display !== 'block') return;
    if (dlg.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.formpilot-sparkle')) return;
    closeDraftDialog(false);
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
      
      const draftedText = resp && resp.success && resp.drafts
        ? (resp.drafts[label] ?? resp.drafts[Object.keys(resp.drafts).find(k => normalizeLabel(k) === normalizeLabel(label))])
        : null;
      if (draftedText) {
        if (currentDraftField) {
           await fillField(currentDraftField, { value: draftedText, type: 'llm' });
           applyHighlight(currentDraftField.element, 'draft');
           dialog.style.display = 'none';
           const doneField = currentDraftField;
           for (const entry of sparkleRegistry) {
             if (entry.field === doneField) {
               entry.sparkle.dataset.fpDone = 'true';
               entry.sparkle.style.display = 'none';
             }
           }
           currentDraftField = null;
           currentSparkleEl = null;
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
  if (!field || !field.element) return;
  // Never attach to native date/time pickers (browser calendar UI).
  // Text inputs with a JS datepicker class still get assist.
  if (isNativeDateInput(field)) return;
  if (field.element.dataset.fpSparkle) return;
  field.element.dataset.fpSparkle = 'true';

  // Reserve right padding on wide text fields so the inside badge
  // doesn't cover typed text. Stored once; host layout otherwise untouched
  // (no parent position mutation — badge is body-level position:fixed).
  const anchor = getSparkleAnchor(field) || field.element;
  if (!field.isCustomWidget && (anchor.tagName === 'INPUT' || anchor.tagName === 'TEXTAREA')) {
    try {
      const rect = anchor.getBoundingClientRect();
      const cs = window.getComputedStyle(anchor);
      if (rect.width > 80 && parseFloat(cs.paddingRight || '0') < 26) {
        if (!anchor.dataset.fpOrigPad) anchor.dataset.fpOrigPad = cs.paddingRight || '';
        anchor.style.paddingRight = '28px';
      }
    } catch (e) { /* non-fatal */ }
  }
  
  const sparkle = document.createElement('div');
  sparkle.className = 'formpilot-sparkle';
  sparkle.textContent = '✨';
  sparkle.setAttribute('role', 'button');
  sparkle.setAttribute('tabindex', '0');
  sparkle.setAttribute('aria-label', `Draft with AI for: ${label}`);
  sparkle.setAttribute('title', 'Draft with AI');
  sparkle.fieldRef = field;

  const entry = { sparkle, field, label, anchor };
  sparkleRegistry.push(entry);

  const open = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    openDraftDialog(field, label, sparkle);
  };
  sparkle.addEventListener('click', open);
  sparkle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open(e);
  });
  
  document.body.appendChild(sparkle);
  positionSparkle(entry);
}

// Keep badges pinned without mutating host layout.
window.addEventListener('scroll', scheduleSparkleReposition, { capture: true, passive: true });
window.addEventListener('resize', scheduleSparkleReposition);

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

(function init() {
  currentPlatform = detectPlatform();
  injectHighlightStyles();
  createDraftDialog();

  collectFields();
  chrome.runtime.sendMessage({ action: 'forms_detected', count: cachedFields.length }).catch(() => {});
  
  domObserver.observe(document.body, { childList: true, subtree: true });
  checkForIframes();
})();
