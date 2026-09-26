// ── FormPilot Content Script ──
// Scans pages for fillable controls using platform-specific adapters,
// resolves each control's kind, matches it against local data, and fills it
// with read-back verification. Talks to the popup/SW via chrome.runtime.

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════

let fpSettings = { highlightDuration: 3, autoDraftMode: false, allowConsentTicks: false };

chrome.storage.sync.get(
  { highlightDuration: 3, autoDraftMode: false, allowConsentTicks: false },
  (items) => { fpSettings = items; }
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.highlightDuration) fpSettings.highlightDuration = changes.highlightDuration.newValue;
  if (changes.autoDraftMode) fpSettings.autoDraftMode = changes.autoDraftMode.newValue;
  if (changes.allowConsentTicks) fpSettings.allowConsentTicks = changes.allowConsentTicks.newValue;
});

const MAX_AUTOFILL_PASSES = 4;
const DOM_SETTLE_MS = 450;

// Autofill run state. Declared up here because hasUserValue() — defined
// further down — needs to know whether a value came from us.
let isAutoFilling = false;
const filledFieldsMap = new WeakMap();

// ═══════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════

function isVisible(el) {
  return isElementVisible(el);
}

/**
 * MutationObserver-based element waiter. Resolves when selector matches
 * inside `parent`, or null on timeout. Used for async widget rendering
 * (e.g. Google Forms dropdown options that render after click).
 */
function waitForElement(selector, { timeout = 2000, parent = document, root = document } = {}) {
  return new Promise((resolve) => {
    const existing = parent.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const obs = new MutationObserver(() => {
      const el = parent.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(parent === document ? root : parent, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

/** Resolves once the DOM has been quiet for `ms`, or after `maxMs`. */
function waitForDomSettle(ms = DOM_SETTLE_MS, maxMs = 1500) {
  return new Promise((resolve) => {
    let quietTimer = null;
    const started = Date.now();
    const obs = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, ms);
    });
    function finish() {
      clearTimeout(quietTimer);
      obs.disconnect();
      resolve();
    }
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setTimeout(finish, Math.max(0, maxMs - (Date.now() - started)));
  });
}

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
    if (current.tagName === 'FIELDSET') {
      const legend = current.querySelector('legend');
      if (legend) return legend.textContent.trim();
    }
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

function sectionLooksLikeConsent(section) {
  const s = normalizeLabel(section || '');
  if (!s) return false;
  return CONSENT_SECTION_HINTS.some(h => s.includes(normalizeLabel(h)));
}

// ═══════════════════════════════════════
// LABEL RESOLUTION — ordered by reliability
// ═══════════════════════════════════════

/**
 * The document or shadow root this element lives in. Label lookups must stay
 * inside it — document.querySelector cannot see into a shadow root, and a
 * direct child of a shadow root has parentElement === null.
 */
function searchRootOf(el) {
  if (!el) return document;
  try {
    const root = el.getRootNode ? el.getRootNode() : document;
    return (root && root.querySelectorAll) ? root : document;
  } catch (e) {
    return document;
  }
}

/** The element that owns a group of controls, as seen from the element itself. */
function parentScopeOf(el) {
  if (!el) return document;
  return el.parentElement || searchRootOf(el);
}

function getLabelByFor(el) {
  if (!el || !el.id) return '';
  let label = null;
  try { label = searchRootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch (e) { label = null; }
  return label ? label.textContent.trim() : '';
}

function getAriaLabel(el) {
  return ((el && el.getAttribute && el.getAttribute('aria-label')) || '').trim();
}

function getAriaLabelledBy(el) {
  const ids = el.getAttribute && el.getAttribute('aria-labelledby');
  if (!ids) return '';
  const parts = ids.split(/\s+/).map(id => {
    const ref = document.getElementById(id);
    return ref ? ref.textContent.trim() : '';
  }).filter(Boolean);
  return parts.join(' ');
}

function getWrappingLabel(el) {
  const label = el.closest && el.closest('label');
  if (!label) return '';
  const clone = label.cloneNode(true);
  clone.querySelectorAll('input, select, textarea').forEach(i => i.remove());
  return clone.textContent.trim();
}

function getProximityLabel(el) {
  let current = parentScopeOf(el);
  let depth = 0;
  while (current && current !== document.body && depth < 5) {
    for (const child of current.children) {
      if (child === el || child.contains(el)) continue;
      if (['LABEL', 'SPAN', 'DIV', 'P'].includes(child.tagName)) {
        const text = child.textContent.trim();
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
  return ((el && el.getAttribute && el.getAttribute('placeholder')) || '').trim();
}

function getSpatialLabel(el) {
  const elRect = el.getBoundingClientRect();
  const elCenter = { x: elRect.left + elRect.width / 2, y: elRect.top + elRect.height / 2 };

  let nearestLabel = '';
  let minDist = Infinity;

  const scope = searchRootOf(el);
  const candidates = scope.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6');
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
  let container = el.closest('[data-params]');

  if (!container) {
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
// KIND DETECTION
// Every control is classified into exactly one FIELD_KIND. The kind decides
// both how a value is chosen and how it is written back.
// ═══════════════════════════════════════

const SKIP_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

const DATEPICKER_CLASS_HINTS = [
  'flatpickr-input', 'datepicker', 'hasDatepicker', 'date-picker', 'datepicker-input',
  'react-datepicker__input', 'air-datepicker', 'ui-datepicker-input', 'dateinput',
  'form-control-date', 'date-field', 'dp__input', 'calendar-input'
];

function isDateField(field) {
  if (!field || !field.element) return false;
  const el = field.element;
  const t = ((el.type || '') + '').toLowerCase();
  if (NATIVE_DATE_INPUT_TYPES.has(t)) return true;
  const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
  if (DATEPICKER_CLASS_HINTS.some(c => cls.includes(c))) return true;
  const ph = (el.getAttribute('placeholder') || '').toLowerCase();
  if (/\b(dd|mm|yyyy|dd\/mm|mm\/dd|date)\b/.test(ph)) return true;
  if (el.getAttribute && el.getAttribute('data-testid') && /date|calendar|dob|birth/i.test(el.getAttribute('data-testid'))) return true;
  // MUI date pickers wrap the real input and expose a toggle button
  if (el.closest && el.closest('[class*="MuiDatePicker"], [class*="MuiDateTimePicker"]')) return true;
  return false;
}

// Native date/time inputs (browser calendar UI) — never auto-fill or sparkle.
function isNativeDateInput(field) {
  if (!field || !field.element) return false;
  const t = ((field.element.type || '') + '').toLowerCase();
  return NATIVE_DATE_INPUT_TYPES.has(t);
}

/** Maps a native input type to its kind, or null when not applicable. */
function kindFromInputType(el) {
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return FIELD_KIND.TEXTAREA;
  if (tag === 'SELECT') return el.multiple ? FIELD_KIND.MULTI_SELECT : FIELD_KIND.SELECT;
  if (tag !== 'INPUT') return null;
  switch ((el.type || 'text').toLowerCase()) {
    case 'radio': return FIELD_KIND.RADIO;
    case 'checkbox': return FIELD_KIND.CHECKBOX_SINGLE;
    case 'date': return FIELD_KIND.DATE;
    case 'datetime-local': return FIELD_KIND.DATETIME;
    case 'month': return FIELD_KIND.MONTH;
    case 'time': return FIELD_KIND.TIME;
    case 'number': return FIELD_KIND.NUMBER;
    case 'email': return FIELD_KIND.EMAIL;
    case 'tel': return FIELD_KIND.TEL;
    case 'url': return FIELD_KIND.URL;
    case 'file': return FIELD_KIND.FILE;
    case 'search': return null; // site search boxes, not form fields
    default: return FIELD_KIND.TEXT;
  }
}

/**
 * True when the element is a *label container* for a control rather than the
 * control itself (e.g. a styled <div> that fronts a hidden <select>).
 */
function isWrapperNotControl(el) {
  if (!el) return true;
  const tag = el.tagName;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return false;
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return false;
  const role = el.getAttribute('role');
  if (['textbox', 'combobox', 'listbox', 'radiogroup', 'spinbutton', 'slider', 'option'].includes(role)) return false;
  return true;
}

/** Infer the kind of an ARIA / custom widget element. */
function kindForCustomWidget(el) {
  const role = el.getAttribute('role') || '';
  if (role === 'radiogroup') return FIELD_KIND.RADIO;
  if (role === 'listbox') return FIELD_KIND.CUSTOM_DROPDOWN;
  if (role === 'combobox') return FIELD_KIND.CUSTOM_DROPDOWN;
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return FIELD_KIND.RICH_TEXT;
  if (el.getAttribute('aria-multiline') === 'true' || el.tagName === 'TEXTAREA') return FIELD_KIND.RICH_TEXT;
  if (role === 'textbox') return FIELD_KIND.TEXT;
  if (role === 'checkbox') return FIELD_KIND.CHECKBOX_SINGLE;
  if (role === 'switch') return FIELD_KIND.CHECKBOX_SINGLE;
  // Framework dropdown fronts (MUI, select2, react-select, Bootstrap…)
  if (isTriggerElement(el) || el.closest && el.closest('.select2-container, .MuiSelect-root, .select__container, .dropdown')) {
    if (isDateField({ element: el })) return FIELD_KIND.DATE;
    return FIELD_KIND.CUSTOM_DROPDOWN;
  }
  if (role === 'group') {
    const boxes = el.querySelectorAll('[role="checkbox"]');
    if (boxes.length) return FIELD_KIND.CHECKBOX_MULTI;
    return FIELD_KIND.UNKNOWN;
  }
  if (role === 'spinbutton') return FIELD_KIND.NUMBER;
  return FIELD_KIND.TEXT;
}

/** Date inputs fronted by a JS picker are text inputs that need a popup. */
function refineKindForDateWidget(el, kind) {
  if (kind !== FIELD_KIND.TEXT && kind !== FIELD_KIND.UNKNOWN) return kind;
  if (isDateField({ element: el })) {
    const t = ((el.type || '') + '').toLowerCase();
    if (NATIVE_DATE_INPUT_TYPES.has(t)) return kindFromInputType(el);
    return FIELD_KIND.DATE; // text input driven by a picker popup
  }
  return kind;
}

// ═══════════════════════════════════════
// OPTION COLLECTION
// Options now carry their DOM element, because filling means clicking or
// checking a specific node, not writing a string.
// ═══════════════════════════════════════

function optionsFromSelect(el) {
  return Array.from(el.options)
    .filter(o => (o.value !== '' || (o.textContent || '').trim() !== ''))
    .map(o => ({
      el: o,
      value: o.value || (o.textContent || '').trim(),
      text: (o.textContent || '').trim(),
      disabled: !!o.disabled,
      selected: !!o.selected
    }));
}

function optionsFromRoleListbox(el) {
  const opts = el.querySelectorAll('[role="option"]');
  return Array.from(opts)
    .filter(o => isVisible(o))
    .map(o => ({
      el: o,
      value: o.getAttribute('data-value') || o.textContent.trim(),
      text: o.textContent.trim(),
      disabled: o.getAttribute('aria-disabled') === 'true',
      selected: o.getAttribute('aria-selected') === 'true'
    }));
}

/** Options for a role="radiogroup" — div-based (GForms) or input-based. */
function optionsFromRadioGroup(el) {
  const divRadios = el.querySelectorAll('[role="radio"]');
  if (divRadios.length > 0) {
    return Array.from(divRadios).map(r => ({
      el: r,
      value: r.getAttribute('data-value') || r.textContent.trim(),
      text: r.textContent.trim(),
      disabled: r.getAttribute('aria-disabled') === 'true',
      selected: r.getAttribute('aria-checked') === 'true'
    }));
  }
  const inputRadios = el.querySelectorAll('input[type="radio"]');
  return Array.from(inputRadios).map(r => ({
    el: r,
    value: r.value || ownLabelOf(r),
    text: ownLabelOf(r) || r.value,
    disabled: !!r.disabled,
    selected: !!r.checked
  }));
}

/** Options for a role="group" of role="checkbox" (GForms checkboxes). */
function optionsFromCheckboxGroup(el) {
  return Array.from(el.querySelectorAll('[role="checkbox"]')).map(c => ({
    el: c,
    value: c.getAttribute('data-value') || c.textContent.trim(),
    text: c.textContent.trim(),
    disabled: c.getAttribute('aria-disabled') === 'true',
    selected: c.getAttribute('aria-checked') === 'true'
  }));
}

/** The label describing a single checkbox/radio, not its question. */
function ownLabelOf(input) {
  let lbl = null;
  if (input.id) {
    try { lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch (e) { lbl = null; }
  }
  if (!lbl && input.closest) lbl = input.closest('label');
  if (lbl) {
    const clone = lbl.cloneNode(true);
    clone.querySelectorAll('input, select, textarea').forEach(i => i.remove());
    const text = clone.textContent.trim();
    if (text) return text;
  }
  const aria = getAriaLabel(input);
  if (aria) return aria;
  // Sibling text node
  if (input.parentElement) {
    for (const sib of input.parentElement.childNodes) {
      if (sib.nodeType === Node.TEXT_NODE && sib.textContent.trim()) return sib.textContent.trim();
    }
  }
  return input.value || '';
}

function collectOptions(el, kind) {
  if (kind === FIELD_KIND.SELECT || kind === FIELD_KIND.MULTI_SELECT) return optionsFromSelect(el);
  if (kind === FIELD_KIND.RADIO) return optionsFromRoleListbox(el).length ? optionsFromRoleListbox(el) : optionsFromRadioGroup(el);
  if (kind === FIELD_KIND.CUSTOM_DROPDOWN) return optionsFromRoleListbox(el);
  if (kind === FIELD_KIND.CHECKBOX_MULTI) return optionsFromCheckboxGroup(el);
  return [];
}

// ═══════════════════════════════════════
// GROUPING — radios and checkboxes are ONE logical field
// ═══════════════════════════════════════

/** Longest common prefix of option labels, cleaned of separators. */
function longestCommonPrefix(labels) {
  const clean = labels.map(l => (l || '').trim()).filter(Boolean);
  if (clean.length < 2) return clean[0] || '';
  let prefix = clean[0];
  for (const l of clean.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < l.length && prefix[i].toLowerCase() === l[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  // Trim trailing separators / filler words left behind by the shared prefix.
  return prefix
    .replace(/[\s\-–—_:;,/|.]+$/g, '')
    .replace(/\b(choose|select|option|is|are|the|of|for)\b\s*$/i, '')
    .trim();
}

/**
 * Walk up from a checkbox/radio to the node that owns the *question*.
 * Keeps climbing while the ancestor holds the same number of boxes, which
 * finds the fieldset or wrapper that groups them without swallowing the
 * whole form.
 */
function findGroupContainer(control, selector) {
  let node = control.parentElement;
  let depth = 0;
  let lastGood = null;
  while (node && node !== document.body && node !== document.documentElement && depth < 10) {
    const count = node.querySelectorAll(selector).length;
    if (count >= 2) {
      const parent = node.parentElement;
      const parentCount = parent ? parent.querySelectorAll(selector).length : 0;
      if (parentCount === count) {
        // Same set continues upward — keep climbing to the outermost owner.
        lastGood = parent && parent !== document.body ? parent : node;
        node = parent;
        depth++;
        continue;
      }
      return node;
    }
    node = node.parentElement;
    depth++;
  }
  return lastGood || control.parentElement || control;
}

/**
 * The question a group of controls (radios, checkboxes) is asking.
 *
 * getSectionContext() only walks *upward*, so it can never see the legend of
 * the very <fieldset> that owns the group, nor a heading that is a *sibling* of
 * the options. Those two cases are extremely common, and getting them wrong
 * made the group's label fall back to its first option ("Yes"), so nothing
 * matched. Reliability order:
 *   1. aria on the group container
 *   2. <legend> of the owning <fieldset>
 *   3. a heading among the container's own children
 *   4. nearest heading above the container
 *   5. the longest prefix shared by the option labels
 *   6. the first option label, so the field is at least matchable
 */
function resolveGroupQuestionLabel(container, options, explicitLabel) {
  if (explicitLabel) return explicitLabel;

  // 1. aria
  const aria = getAriaLabel(container) || getAriaLabelledBy(container);
  if (aria && !/^\d+$/.test(aria)) return aria;

  // 2. owning fieldset's legend
  const fieldset = container && container.closest ? container.closest('fieldset') : null;
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend && legend.textContent.trim()) return legend.textContent.trim();
  }

  // 3. a heading, or any plain question text, that is a sibling of the options
  if (container) {
    for (const child of container.children) {
      const isHeading = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(child.tagName) || child.getAttribute('role') === 'heading';
      if (isHeading) {
        const text = child.textContent.trim();
        if (text && text.length < 120) return text;
        continue;
      }
      // Real forms very often use a bare <div>/<span> for the question. It has
      // to be a non-interactive element that does not itself contain one of
      // the options, otherwise we would read an option as the question.
      if (!['DIV', 'SPAN', 'P'].includes(child.tagName)) continue;
      if (child.getAttribute('role') || child.hasAttribute('aria-haspopup')) continue;
      if (child.querySelector('input, select, textarea, [role="radio"], [role="checkbox"], [role="option"]')) continue;
      if (child.querySelector('button, a, .tpl-dropdown, .select2-container')) continue;
      const text = child.textContent.trim();
      if (text && text.length > 0 && text.length < 120) return text;
    }
  }

  // 4. nearest heading above
  const section = getSectionContext(container);
  if (section && section.length < 120) return section;

  // 5. shared prefix across option labels ("Employment type - Full time")
  const lcp = longestCommonPrefix((options || []).map(o => o.text));
  if (lcp && lcp.length >= 3) return lcp;

  // 6. last resort
  return options && options[0] ? options[0].text : '';
}

/** Kept for callers that only deal with radios. */
function resolveRadioGroupLabel(groupEl, radios, options) {
  return resolveGroupQuestionLabel(groupEl, options);
}

/**
 * Section context for a group. A group's own question is not a section, so we
 * prefer a real ancestor heading and fall back to the question text (which is
 * what the negative-keyword guards need when there is no heading at all).
 */
function resolveGroupSection(el, label) {
  return getSectionContext(el) || (label || '');
}

/** Build one RADIO field from a set of radio controls. */
function buildRadioField(groupEl, radios, opts = {}) {
  // ARIA groups (Google/MS Forms) carry no <input> children — derive the
  // options from the group container itself.
  const options = (radios && radios.length)
    ? radios.map(r => ({
      el: r,
      value: r.value || ownLabelOf(r),
      text: ownLabelOf(r) || r.value,
      disabled: !!r.disabled,
      selected: !!r.checked
    }))
    : (groupEl ? optionsFromRadioGroup(groupEl) : []);

  if (!options.length) return null;

  const label = opts.label || resolveRadioGroupLabel(groupEl, radios, options);
  const el = groupEl || radios[0];
  return {
    element: el,
    optionsEl: el,
    groupKey: opts.groupKey || '',
    kind: FIELD_KIND.RADIO,
    type: 'radio',
    tagName: el.tagName,
    id: el.id || '',
    name: radios && radios[0] ? (radios[0].getAttribute('name') || '') : '',
    placeholder: '',
    labelText: label,
    ariaLabel: getAriaLabel(el),
    sectionContext: resolveGroupSection(el, label),
    isCustomWidget: opts.isCustomWidget || false,
    widgetRole: opts.widgetRole || 'radiogroup',
    options,
    isConsent: false,
    dateOrder: null
  };
}

/**
 * Classify a checkbox: legal/attestation vs a real data answer.
 * Returns 'consent' or 'data'.
 */
function classifyCheckbox(input, ownLabel, section) {
  if (isConsentLabel(ownLabel)) return 'consent';
  if (sectionLooksLikeConsent(section)) return 'consent';
  return 'data';
}

function buildCheckboxField(groupEl, boxes, opts = {}) {
  const options = boxes.map(b => ({
    el: b,
    value: b.value || ownLabelOf(b),
    text: ownLabelOf(b) || b.value,
    disabled: !!b.disabled,
    selected: !!b.checked
  }));
  return {
    element: groupEl,
    optionsEl: groupEl,
    groupKey: opts.groupKey || '',
    kind: opts.multi ? FIELD_KIND.CHECKBOX_MULTI : FIELD_KIND.CHECKBOX_SINGLE,
    type: 'checkbox',
    tagName: groupEl.tagName,
    id: groupEl.id || '',
    name: boxes[0] ? (boxes[0].getAttribute('name') || '') : '',
    placeholder: '',
    labelText: resolveGroupQuestionLabel(groupEl, options, opts.label),
    ariaLabel: getAriaLabel(groupEl),
    sectionContext: opts.sectionContext || resolveGroupSection(groupEl, opts.label),
    isCustomWidget: true,
    widgetRole: 'checkboxgroup',
    options,
    isConsent: !!opts.isConsent,
    dateOrder: null
  };
}

// ═══════════════════════════════════════
// DATE-PART GROUPS (three adjacent dd / mm / yyyy boxes)
// ═══════════════════════════════════════

function isDatePartInput(el) {
  if (!el || el.tagName !== 'INPUT') return false;
  const type = (el.type || 'text').toLowerCase();
  if (!['text', 'tel', 'number', ''].includes(type)) return false;
  const ph = (el.getAttribute('placeholder') || '').toLowerCase();
  const aria = (el.getAttribute('aria-label') || '').toLowerCase();
  const part = (el.getAttribute('data-fp-part') || '').toLowerCase();
  if (part === 'dd' || part === 'mm' || part === 'yyyy') return true;
  if (/^(dd|day)\b/.test(ph) || /^(dd|day)\b/.test(aria)) return true;
  if (/^(mm|month)\b/.test(ph) || /^(mm|month)\b/.test(aria)) return true;
  if (/^(yyyy|yr|year)\b/.test(ph) || /^(yyyy|yr|year)\b/.test(aria)) return true;
  return false;
}

function datePartRole(el) {
  const blob = ((el.getAttribute('data-fp-part') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
  if (/yyyy|year|^yr\b/.test(blob)) return 'yyyy';
  if (/\bmm\b|^month/.test(blob)) return 'mm';
  return 'dd';
}

function findDatePartGroup(input) {
  const parent = input.parentElement;
  if (!parent) return null;
  const inputs = Array.from(parent.querySelectorAll('input')).filter(isDatePartInput);
  if (inputs.length < 2) return null;
  const roles = new Set(inputs.map(datePartRole));
  if (!roles.has('yyyy') || !roles.has('mm') || !roles.has('dd')) return null;
  return { container: parent, inputs };
}

// ═══════════════════════════════════════
// FIELD OBJECT
// ═══════════════════════════════════════

function currentValueOf(field) {
  const el = field.element;
  if (!el) return '';
  switch (field.kind) {
    case FIELD_KIND.MULTI_SELECT:
      return Array.from(el.selectedOptions || []).map(o => o.value || o.textContent.trim());
    case FIELD_KIND.CHECKBOX_MULTI:
      return field.options.filter(o => o.selected).map(o => o.value);
    case FIELD_KIND.RADIO: {
      const checked = field.options.find(o => o.selected);
      return checked ? checked.value : '';
    }
    case FIELD_KIND.CHECKBOX_SINGLE: {
      const opt = field.options[0];
      if (opt) return opt.selected ? opt.value : '';
      return el.checked ? (el.value || 'on') : '';
    }
    case FIELD_KIND.CUSTOM_DROPDOWN: {
      const byVal = el.getAttribute('data-value') || el.getAttribute('aria-valuetext');
      // readTriggerValue() already filters out placeholder text such as
      // "Select…", which is what stops an untouched dropdown from looking
      // like a field the user had already filled.
      const candidate = readTriggerValue(el) || (looksLikePlaceholder(byVal) ? '' : (byVal || ''));
      return candidate ? String(candidate).trim() : '';
    }
    case FIELD_KIND.RICH_TEXT:
      return (el.textContent || '').trim();
    case FIELD_KIND.DATE_PARTS: {
      // dateParts holds the *elements*; read their current values, not the
      // elements themselves, or every date-part group looks pre-filled.
      const parts = field.dateParts || {};
      const read = role => (parts[role] && parts[role].value !== undefined ? String(parts[role].value).trim() : '');
      return `${read('dd')}/${read('mm')}/${read('yyyy')}`;
    }
    default:
      return el.value === undefined || el.value === null ? '' : String(el.value);
  }
}

/**
 * Whether this control already holds a value the *user* put there.
 * A value FormPilot itself wrote is always replaceable; this is what stops us
 * from stomping a choice the user picked by hand while still letting a repeat
 * autofill correct its own earlier answer.
 */
function hasUserValue(field) {
  if (filledFieldsMap.has(field.element)) return false;
  // A date-part group reads as "//" when all three boxes are empty, so check
  // the boxes themselves rather than the joined string.
  if (field.kind === FIELD_KIND.DATE_PARTS) {
    const parts = field.dateParts || {};
    return ['dd', 'mm', 'yyyy'].some(role => parts[role] && String(parts[role].value || '').trim() !== '');
  }
  const v = currentValueOf(field);
  if (Array.isArray(v)) return v.filter(x => x !== '' && x !== null).length > 0;
  return String(v === null || v === undefined ? '' : v).trim() !== '';
}

function buildFieldObj(el, labelText, isCustom, widgetRole, kind) {
  const resolvedKind = kind || (isCustom ? kindForCustomWidget(el) : (kindFromInputType(el) || FIELD_KIND.UNKNOWN));
  const finalKind = refineKindForDateWidget(el, resolvedKind);
  return {
    element: el,
    optionsEl: el,
    groupKey: '',
    kind: finalKind,
    type: el.type || el.tagName?.toLowerCase() || widgetRole,
    tagName: el.tagName,
    id: el.id || '',
    name: el.getAttribute ? (el.getAttribute('name') || '') : '',
    placeholder: getPlaceholder(el),
    labelText: labelText,
    ariaLabel: getAriaLabel(el),
    sectionContext: getSectionContext(el),
    isCustomWidget: isCustom,
    widgetRole: widgetRole,
    options: collectOptions(el, finalKind),
    isConsent: false,
    dateOrder: detectDateOrder(el),
    dateParts: null
  };
}

function fieldLabelOf(field) {
  return (field.labelText || field.placeholder || field.ariaLabel || '').trim();
}

// ═══════════════════════════════════════
// ADAPTER: GENERIC (standard HTML forms, ATS platforms)
// ═══════════════════════════════════════

const GenericAdapter = {
  collectFields() {
    const fields = [];
    const claimed = new Set();
    const datePartGroups = [];

    // ── Pass 1: radios → one field per group ──
    const radios = deepQueryAll(document, 'input[type="radio"]');
    const radioGroups = new Map();
    for (const r of radios) {
      if (r.disabled || !isVisible(r)) continue;
      const name = r.getAttribute('name') || '';
      const key = name ? `name:${name}` : '';
      if (key) {
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(r);
      }
    }
    for (const [key, group] of radioGroups) {
      const container = findGroupContainer(group[0], 'input[type="radio"]');
      for (const r of group) claimed.add(r);
      const field = buildRadioField(container, group, { groupKey: key });
      if (field) fields.push(field);
    }
    // Radios with no shared name: each is its own single-option question.
    for (const r of radios) {
      if (claimed.has(r) || r.disabled || !isVisible(r)) continue;
      claimed.add(r);
      const field = buildRadioField(null, [r], { groupKey: `solo:${r.id || Math.random()}` });
      if (field) fields.push(field);
    }

    // ── Pass 2: checkboxes → consent boxes, data groups, singletons ──
    const boxes = deepQueryAll(document, 'input[type="checkbox"]');
    const boxGroups = new Map();
    for (const b of boxes) {
      if (b.disabled || !isVisible(b)) continue;
      const own = ownLabelOf(b);
      const section = getSectionContext(b);
      const kind = classifyCheckbox(b, own, section);
      if (kind === 'consent') {
        claimed.add(b);
        fields.push(buildCheckboxField(findGroupContainer(b, 'input[type="checkbox"]'), [b], {
          groupKey: `consent:${b.id || b.name || Math.random()}`,
          label: own || section || 'Consent',
          sectionContext: section,
          isConsent: true
        }));
        continue;
      }
      const container = findGroupContainer(b, 'input[type="checkbox"]');
      const siblingCount = container ? container.querySelectorAll('input[type="checkbox"]').length : 1;
      if (siblingCount >= 2) {
        const key = container;
        if (!boxGroups.has(key)) boxGroups.set(key, []);
        boxGroups.get(key).push(b);
      } else {
        claimed.add(b);
        fields.push(buildCheckboxField(b.parentElement || b, [b], {
          groupKey: `solo:${b.id || b.name || Math.random()}`,
          label: own || section || '',
          sectionContext: section
        }));
      }
    }
    for (const [container, group] of boxGroups) {
      for (const b of group) claimed.add(b);
      const first = group[0];
      const section = getSectionContext(container || first);
      fields.push(buildCheckboxField(container, group, {
        multi: true,
        groupKey: `group:${(container && container.tagName) || 'div'}:${group.length}`,
        label: section || longestCommonPrefix(group.map(b => ownLabelOf(b))),
        sectionContext: section
      }));
    }

    // ── Pass 3: date-part triples, before the generic input sweep ──
    for (const input of deepQueryAll(document, 'input')) {
      if (claimed.has(input)) continue;
      if (!isDatePartInput(input)) continue;
      const group = findDatePartGroup(input);
      if (!group) continue;
      if (datePartGroups.includes(group.container)) continue;
      datePartGroups.push(group.container);
      for (const i of group.inputs) claimed.add(i);
      const section = getSectionContext(group.container);
      const field = {
        element: group.container,
        optionsEl: group.container,
        groupKey: `dateparts:${group.inputs.length}`,
        kind: FIELD_KIND.DATE_PARTS,
        type: 'date-parts',
        tagName: group.container.tagName,
        id: group.container.id || '',
        name: '',
        placeholder: '',
        // The first box's own aria-label is "Day", which is useless as a
        // question. Prefer the section heading, then the text sitting next to
        // the strip, and only then fall back to per-input labels.
        labelText: section || getProximityLabel(group.container) || resolveLabel(group.inputs[0]),
        ariaLabel: getAriaLabel(group.inputs[0]),
        sectionContext: section,
        isCustomWidget: true,
        widgetRole: 'dateparts',
        options: group.inputs.map(i => ({ el: i, value: datePartRole(i), text: datePartRole(i), disabled: false, selected: false })),
        isConsent: false,
        dateOrder: detectDateOrder(group.inputs[0]),
        dateParts: group.inputs.reduce((acc, i) => { acc[datePartRole(i)] = i; return acc; }, {}),
        datePartValues: { dd: '', mm: '', yyyy: '' }
      };
      fields.push(field);
    }

    // ── Pass 4: everything else ──
    for (const el of deepQueryAll(document, 'input, select, textarea')) {
      if (claimed.has(el)) continue;
      if (el.tagName === 'INPUT' && SKIP_TYPES.has(el.type)) continue;
      if (!isVisible(el)) continue;
      if (el.disabled) continue;
      // A readonly input is normally a display-only mirror of some other
      // control, but a readonly *date* input is the real target of a JS
      // picker (flatpickr, MUI, react-datepicker), so keep those.
      if (el.readOnly && !isDateField({ element: el })) continue;
      claimed.add(el);
      const kind = refineKindForDateWidget(el, kindFromInputType(el) || FIELD_KIND.UNKNOWN);
      if (kind === FIELD_KIND.UNKNOWN) continue;
      fields.push(buildFieldObj(el, resolveLabel(el), false, '', kind));
    }

    // ── Pass 5: ARIA + framework widgets not already captured ──
    const WIDGET_SEL = '[role="combobox"], [role="listbox"], [role="textbox"], [role="radiogroup"], ' +
      '[role="group"], [role="checkbox"], [role="switch"], [role="spinbutton"], ' +
      '[contenteditable="true"], [aria-haspopup="listbox"], [aria-haspopup="menu"], ' +
      '.MuiSelect-select, .MuiNativeSelect-select, .select2-selection, .chosen-container, ' +
      '.select__control, .ss__control, .dropdown-toggle, .v-select, .ant-select-selector, ' +
      '.multiselect-select, .flatpickr-input, .react-datepicker__input, .air-datepicker, ' +
      '.ui-datepicker-input, [class*="select" i][class*="control" i], [class*="select" i][class*="dropdown" i]';
    for (const el of deepQueryAll(document, WIDGET_SEL)) {
      if (claimed.has(el)) continue;
      if (!isVisible(el)) continue;
      if (el.disabled) continue;
      // An individual ARIA radio/checkbox is collected as part of its group
      // container, never on its own — otherwise it appears twice.
      if ((el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch')
        && el.closest('[role="radiogroup"], [role="group"]')) continue;
      // Skip a wrapper that merely contains a real, already-claimed control.
      if (el.querySelector('input, select, textarea:not([readonly])')) {
        const inner = el.querySelector('input, select, textarea');
        if (inner && !inner.readOnly && !inner.disabled) continue;
      }
      const kind = kindForCustomWidget(el);
      if (kind === FIELD_KIND.UNKNOWN) continue;
      claimed.add(el);
      if (kind === FIELD_KIND.RADIO) {
        const field = buildRadioField(el, [], { groupKey: `aria:${getAriaLabel(el) || Math.random()}`, isCustomWidget: true, label: resolveLabel(el) });
        if (field) fields.push(field);
        continue;
      }
      fields.push(buildFieldObj(el, resolveLabel(el), true, el.getAttribute('role') || 'widget', kind));
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
    const claimed = new Set();

    // 1. Short answer + paragraph (real <input> and <textarea>)
    for (const el of deepQueryAll(document, 'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input:not([type]), textarea')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.type === 'search' || el.getAttribute('role') === 'search') continue;
      if (el.closest('[role="navigation"], [role="banner"], header')) continue;
      claimed.add(el);
      const kind = refineKindForDateWidget(el, kindFromInputType(el) || FIELD_KIND.UNKNOWN);
      fields.push(buildFieldObj(el, resolveGFormsLabel(el), false, '', kind));
    }

    // 2. Dropdown selects (role="listbox")
    for (const el of deepQueryAll(document, '[role="listbox"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      claimed.add(el);
      fields.push(buildFieldObj(el, resolveGFormsLabel(el), true, 'listbox', FIELD_KIND.CUSTOM_DROPDOWN));
    }

    // 3. Multiple choice (role="radiogroup")
    for (const el of deepQueryAll(document, '[role="radiogroup"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      claimed.add(el);
      const field = buildRadioField(el, [], { groupKey: `gf:${el.getAttribute('aria-label') || Math.random()}`, isCustomWidget: true, label: resolveGFormsLabel(el) });
      if (field) fields.push(field);
    }

    // 4. Checkboxes (role="group" containing role="checkbox")
    for (const el of deepQueryAll(document, '[role="group"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      const cbs = el.querySelectorAll('[role="checkbox"]');
      if (cbs.length === 0) continue;
      claimed.add(el);
      const label = resolveGFormsLabel(el);
      const optionTexts = Array.from(cbs).map(c => c.textContent.trim());
      const consent = isConsentLabel(label) || (optionTexts.length === 1 && isConsentLabel(optionTexts[0]));
      const field = {
        element: el,
        optionsEl: el,
        groupKey: `gf:${label || Math.random()}`,
        kind: cbs.length > 1 ? FIELD_KIND.CHECKBOX_MULTI : FIELD_KIND.CHECKBOX_SINGLE,
        type: 'checkbox',
        tagName: el.tagName,
        id: el.id || '',
        name: '',
        placeholder: '',
        labelText: label,
        ariaLabel: getAriaLabel(el),
        sectionContext: getSectionContext(el),
        isCustomWidget: true,
        widgetRole: 'checkboxgroup',
        options: optionsFromCheckboxGroup(el),
        isConsent: consent,
        dateOrder: null
      };
      if (consent && cbs.length === 1) field.labelText = optionTexts[0] || label;
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
    const claimed = new Set();

    // 1. Text inputs + textareas
    for (const el of deepQueryAll(document, 'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input[type="datetime-local"], input[type="month"], input[type="time"], input:not([type]), textarea')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.closest('[role="navigation"], [role="banner"], header, nav')) continue;
      claimed.add(el);
      const kind = refineKindForDateWidget(el, kindFromInputType(el) || FIELD_KIND.UNKNOWN);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), false, '', kind));
    }

    // 2. Radio groups
    for (const el of deepQueryAll(document, '[role="radiogroup"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      claimed.add(el);
      const field = buildRadioField(el, [], { groupKey: `ms:${el.getAttribute('aria-label') || Math.random()}`, isCustomWidget: true, label: resolveMSFormsLabel(el) });
      if (field) fields.push(field);
    }

    // 3. Combobox / custom dropdowns
    for (const el of deepQueryAll(document, '[role="combobox"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      // MS Forms renders its option list as a *sibling* listbox.
      if (el.querySelector('input')) continue;
      claimed.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), true, 'combobox', FIELD_KIND.CUSTOM_DROPDOWN));
    }

    // 4. Checkbox groups
    for (const el of deepQueryAll(document, '[role="group"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      const cbs = el.querySelectorAll('[role="checkbox"]');
      if (!cbs.length) continue;
      claimed.add(el);
      const label = resolveMSFormsLabel(el);
      const opts = optionsFromCheckboxGroup(el);
      const consent = isConsentLabel(label) || (opts.length === 1 && isConsentLabel(opts[0].text));
      fields.push({
        element: el,
        optionsEl: el,
        groupKey: `ms:${label || Math.random()}`,
        kind: opts.length > 1 ? FIELD_KIND.CHECKBOX_MULTI : FIELD_KIND.CHECKBOX_SINGLE,
        type: 'checkbox',
        tagName: el.tagName,
        id: el.id || '',
        name: '',
        placeholder: '',
        labelText: opts.length === 1 && consent ? opts[0].text : label,
        ariaLabel: getAriaLabel(el),
        sectionContext: getSectionContext(el),
        isCustomWidget: true,
        widgetRole: 'checkboxgroup',
        options: opts,
        isConsent: consent,
        dateOrder: null
      });
    }

    // 5. Standard selects and remaining date inputs
    for (const el of deepQueryAll(document, 'select')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      claimed.add(el);
      fields.push(buildFieldObj(el, resolveMSFormsLabel(el), false, ''));
    }
    for (const el of deepQueryAll(document, 'input[type="date"], input[type="datetime-local"], input[type="month"], input[type="time"]')) {
      if (claimed.has(el) || !isVisible(el)) continue;
      claimed.add(el);
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
    case 'ms-forms': return MSFormsAdapter;
    default: return GenericAdapter;
  }
}

function collectFields() {
  cachedFields = getAdapter().collectFields();
  return cachedFields;
}

// ═══════════════════════════════════════
// MUTATION OBSERVER — re-scans when new form elements appear (SPA support)
// ═══════════════════════════════════════

const FORM_SELECTORS = 'input, select, textarea, [role="listbox"], [role="radiogroup"], [role="combobox"], ' +
  '[role="textbox"], [role="group"], [role="checkbox"], [role="switch"], [contenteditable="true"], ' +
  '[aria-haspopup="listbox"], .MuiSelect-select, .select2-selection, .dropdown-toggle';

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
// MATCHING LOGIC
// ═══════════════════════════════════════

function getProfileValue(type, profile) {
  if (COMPOSITE_RULES[type]) return COMPOSITE_RULES[type](profile);
  const v = profile[type];
  if (v === null || v === undefined) return '';
  return v;
}

/**
 * Decide which profile key answers this control, or null for "not resolvable
 * locally". Label utilities and the negative-keyword lists live in
 * shared/matching.js; only the control-specific guards live here.
 */
function matchField(field, profile, corrections = {}) {
  const section = normalizeLabel(field.sectionContext || '');
  for (const skip of SKIP_SECTIONS) {
    if (sectionHasToken(section, normalizeLabel(skip))) return null;
  }

  const label = normalizeLabel(fieldLabelOf(field));

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
    // Also block classic "X's Y" other-person phrasing even without a section,
    // e.g. "father name", "spouse phone", "manager email".
    let otherPersonCue = false;
    for (const hard of HARD_NEGATIVE_LABEL_KEYWORDS) {
      if (labelHasToken(label, hard)) { otherPersonCue = true; break; }
    }
    if (otherPersonCue) return null;
  }

  // Consent / attestation boxes are never matched to profile data.
  if (field.isConsent) return null;

  // 1. Corrections first (exact + normalized fallback)
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

  // 2. Signatures (case-insensitive + punctuation-insensitive)
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

  // 3. Keyword mapping. All candidates are scored and the MOST SPECIFIC
  //    keyword wins, rather than whichever field type happens to be declared
  //    first. Without this, "Total experience in months" matched the generic
  //    "experience" keyword and was answered with years.
  const labelExact = label;
  let best = null;
  for (const [type, keywords] of Object.entries(FIELD_KEYWORDS)) {
    for (const rawKw of keywords) {
      const kw = normalizeLabel(rawKw);
      if (!kw) continue;
      if (!labelHasToken(label, kw)) continue;
      // Longest keyword wins; an exact whole-label match outranks a partial one.
      const score = (labelExact === kw ? 10000 : 0) + kw.length;
      if (!best || score > best.score) best = { type, kw, score };
    }
  }
  if (best) {
    const value = getProfileValue(best.type, profile);
    // Empty profile value → treat as miss so LLM/sparkle can try,
    // instead of a silent fillField failure.
    if (value === '' || value === null || value === undefined) return null;
    return { type: best.type, value };
  }

  return null;
}


// ═══════════════════════════════════════
// FILLING — one verified path per kind
// Every path returns a status so failures are visible instead of silent.
// ═══════════════════════════════════════

const FILL_OK = 'filled';
const FILL_NO_OPTION = 'no-option';
const FILL_NO_VALUE = 'no-value';
const FILL_DEFERRED = 'deferred';
const FILL_UNSUPPORTED = 'unsupported';
const FILL_SKIPPED = 'skipped-existing';
const FILL_FAILED = 'failed';

function ok(value) { return { status: FILL_OK, value }; }
function fail(status, value) { return { status, value: value === undefined ? null : value }; }

/** Select one option in a <select>. */
function fillSelectOne(field, option) {
  const el = field.element;
  const before = el.value;
  if (before === option.value) { blurToCommit(el); return ok(option.value); }
  setNativeInputValue(el, option.value);
  blurToCommit(el);
  if (el.value !== option.value) return fail(FILL_FAILED, option.value);
  return ok(option.value);
}

/** Select several options in a <select multiple>. */
function fillSelectMultiple(field, options) {
  const el = field.element;
  for (const o of Array.from(el.options)) o.selected = false;
  for (const o of options) {
    for (const candidate of Array.from(el.options)) {
      if (candidate.value === o.value || candidate.textContent.trim() === o.text) {
        candidate.selected = true;
        break;
      }
    }
  }
  blurToCommit(el);
  const nowSelected = Array.from(el.selectedOptions).map(o => o.value);
  const wanted = options.map(o => o.value);
  const allSet = wanted.every(v => nowSelected.includes(v));
  return allSet ? ok(wanted) : fail(FILL_FAILED, nowSelected);
}

/** Check exactly one radio in a group. */
function fillRadio(field, option) {
  if (option.selected) { return ok(option.value); }
  const target = option.el;
  if (!target) return fail(FILL_FAILED, option.value);

  if (target.tagName === 'INPUT') {
    forceChecked(target, true);
    if (target.checked) { blurToCommit(target); return ok(option.value); }
    return fail(FILL_FAILED, option.value);
  }

  // Div/span radio (Google Forms, MS Forms)
  userClick(target);
  if (target.getAttribute('aria-checked') === 'true') return ok(option.value);
  // Some wrappers only mark a child
  const inner = target.querySelector('[role="radio"], input[type="radio"]');
  if (inner && (inner.getAttribute('aria-checked') === 'true' || inner.checked)) return ok(option.value);
  if (target.querySelector('[aria-checked="true"], input:checked')) return ok(option.value);
  return fail(FILL_FAILED, option.value);
}

/** Set a checkbox (or checkbox group) to an exact checked/unchecked state. */
function fillCheckbox(field, option, shouldBeChecked) {
  const target = option.el;
  if (!target) return fail(FILL_FAILED, option.value);
  if (target.tagName === 'INPUT') {
    forceChecked(target, shouldBeChecked);
    if (target.checked === shouldBeChecked) return ok(shouldBeChecked ? option.value : '');
    return fail(FILL_FAILED, option.value);
  }
  const isChecked = () => target.getAttribute('aria-checked') === 'true' || (target.querySelector && !!target.querySelector('input:checked'));
  if (isChecked() !== shouldBeChecked) userClick(target);
  if (isChecked() === shouldBeChecked) return ok(shouldBeChecked ? option.value : '');
  return fail(FILL_FAILED, option.value);
}

/** Fill a rich-text / contenteditable region. */
function fillRichText(field, value) {
  return writeContentEditable(field.element, value) ? ok(String(value)) : fail(FILL_FAILED, value);
}

/** Fill dd / mm / yyyy boxes. */
function fillDateParts(field, rawValue) {
  const normalized = normalizeDateValue(rawValue, FIELD_KIND.DATE_PARTS, field.dateOrder);
  if (!normalized || typeof normalized !== 'object') return fail(FILL_NO_VALUE, rawValue);
  let allSet = true;
  for (const role of ['dd', 'mm', 'yyyy']) {
    const input = field.dateParts[role];
    if (!input) continue;
    setNativeInputValue(input, normalized[role]);
    blurToCommit(input);
    if (String(input.value).trim() !== String(normalized[role]).trim()) allSet = false;
  }
  return allSet ? ok(normalized) : fail(FILL_FAILED, rawValue);
}

/** Fill a native or picker-backed date control. */
function fillDateField(field, rawValue) {
  const el = field.element;
  const kind = field.kind;

  if (kind === FIELD_KIND.DATE && el.tagName === 'INPUT' && el.readOnly) {
    // readonly text input behind a JS picker (flatpickr, MUI, react-datepicker)
    return fillPickerDate(field, rawValue);
  }

  const normalized = normalizeDateValue(rawValue, kind, field.dateOrder);
  if (normalized === null || typeof normalized !== 'string') return fail(FILL_NO_VALUE, rawValue);

  const before = el.value;
  if (before === normalized) { blurToCommit(el); return ok(normalized); }
  setNativeInputValue(el, normalized);
  blurToCommit(el);
  // Browsers silently reject a malformed value — so read back and compare.
  if (String(el.value).trim() !== normalized) {
    return fail(el.value ? FILL_FAILED : FILL_NO_VALUE, normalized);
  }
  return ok(normalized);
}

/** Drive a JS date-picker popup to a specific day. */
function fillPickerDate(field, rawValue) {
  const parts = parseDateParts(rawValue);
  if (!parts) return fail(FILL_NO_VALUE, rawValue);
  const input = field.element;
  const before = snapshotVisiblePopups();
  openDropdown(input);
  const popup = pickOpenedPopup(input, before, null);
  if (!popup) {
    closeDropdown(input);
    return fail(FILL_FAILED, rawValue);
  }
  const options = readPopupOptions(popup);
  const pad = n => String(n).padStart(2, '0');
  const wantFull = pad(parts.d);
  const wantShort = String(parts.d);
  const day = options.find(o => {
    const t = o.text.replace(/\D/g, '');
    return t === wantFull || t === wantShort;
  });
  if (day && !day.disabled) {
    userClick(day.el);
  } else {
    // Typing into a flatpickr input is the reliable fallback.
    const typed = typeIntoWidget(input, `${pad(parts.d)}/${pad(parts.m)}/${parts.y}`);
    if (!typed) { closeDropdown(input); return fail(FILL_NO_OPTION, rawValue); }
  }
  closeDropdown(input);
  const now = String(input.value || '').trim();
  if (!now) return fail(FILL_FAILED, rawValue);
  return ok(now);
}

/**
 * Fill a custom dropdown.
 *
 * The important part is that we open the widget *before* choosing an option.
 * On Google Forms and MS Forms the options do not exist in the DOM until the
 * list is opened — often rendered at body level, detached from the trigger —
 * so resolving against a pre-read option list always came up empty. We open,
 * snapshot which popup is ours, read its options, then match and click.
 */
async function fillCustomDropdown(field, option, matchData) {
  const trigger = field.element;
  const desiredText = (option && (option.text || option.value)) || '';

  const popup = await openDropdownAndWait(trigger);
  if (popup) {
    const liveOptions = readPopupOptions(popup);
    // Prefer the live list; fall back to anything known statically.
    const pool = liveOptions.length ? liveOptions : (field.options || []);
    const { option: hit, reason } = resolveOption(pool, desiredText, matchData && matchData.type);
    if (hit && !hit.disabled) {
      userClick(hit.el);
      await sleep(60);
      const shown = readTriggerValue(trigger) || trigger.getAttribute('data-value') || '';
      closeDropdown(trigger);
      if (shown) return ok(shown);
      // No visible text (some widgets only update a hidden input) — accept the
      // click, but only if the option is now marked selected.
      if (hit.selected || (hit.el.getAttribute && hit.el.getAttribute('aria-selected') === 'true')) {
        return ok(desiredText);
      }
      return fail(FILL_FAILED, desiredText);
    }
    // Opened, but the option is not there — type-ahead handles filtered lists.
    closeDropdown(trigger);
    if (typeIntoWidget(trigger, desiredText)) {
      await sleep(80);
      const shown = readTriggerValue(trigger) || trigger.getAttribute('data-value') || '';
      closeDropdown(trigger);
      if (shown) return ok(shown);
      return fail(FILL_NO_OPTION, desiredText);
    }
    return fail(reason === 'deferred' ? FILL_DEFERRED : FILL_NO_OPTION, desiredText);
  }

  // Nothing opened: the widget may be keyboard-driven (MS Forms combobox) or
  // its options may be statically present but visually hidden.
  const statics = field.options || [];
  if (statics.length) {
    const { option: hit } = resolveOption(statics, desiredText, matchData && matchData.type);
    if (hit) {
      userClick(hit.el);
      await sleep(40);
      const shown = readTriggerValue(trigger) || trigger.getAttribute('data-value') || '';
      if (shown) return ok(shown);
      if (hit.selected) return ok(desiredText);
    }
  }
  if (keyboardSelect(trigger, desiredText)) {
    await sleep(60);
    const shown = readTriggerValue(trigger) || trigger.getAttribute('data-value') || '';
    if (shown) return ok(shown);
  }
  closeDropdown(trigger);
  return fail(FILL_NO_OPTION, desiredText);
}

/**
 * Main entry point. Chooses the strategy for the field's kind, then verifies
 * the result by reading the control back.
 *
 * @param matchData { type, value, choose? } — `choose` lets the LLM pin an
 *        exact option; otherwise `value` is resolved against the options.
 */
async function fillField(field, matchData) {
  if (!matchData) return fail(FILL_NO_VALUE);
  if (matchData.value === '' || matchData.value === null || matchData.value === undefined) return fail(FILL_NO_VALUE, null);
  if (typeof matchData.value === 'string' && matchData.value.trim() === '') return fail(FILL_NO_VALUE, null);

  const kind = field.kind;
  const val = matchData.value;

  // ── File inputs: cannot be scripted ──
  if (kind === FIELD_KIND.FILE) return fail(FILL_UNSUPPORTED, 'file');

  // ── Consent boxes: only ever ticked with explicit opt-in ──
  if (field.isConsent && !fpSettings.allowConsentTicks) {
    return fail(FILL_SKIPPED, 'consent');
  }

  // ── Rich text ──
  if (kind === FIELD_KIND.RICH_TEXT) {
    if (hasUserValue(field) && matchData.type !== 'correction') return fail(FILL_SKIPPED);
    return fillRichText(field, val);
  }

  // ── Dates ──
  if (DATE_KINDS.has(kind)) {
    if (hasUserValue(field) && matchData.type !== 'correction') return fail(FILL_SKIPPED);
    return kind === FIELD_KIND.DATE_PARTS ? fillDateParts(field, val) : fillDateField(field, val);
  }

  // ── Multi-value choice controls ──
  if (kind === FIELD_KIND.MULTI_SELECT) {
    if (hasUserValue(field) && matchData.type !== 'correction') return fail(FILL_SKIPPED);
    // Only fill from a genuine list (profile skills/languages). Never let the
    // LLM's single scalar string fan out across a multi-select.
    const { options: hits } = resolveMultipleOptions(field.options, val);
    if (!hits.length) return fail(FILL_NO_OPTION, val);
    return fillSelectMultiple(field, hits);
  }

  if (kind === FIELD_KIND.CHECKBOX_MULTI) {
    if (hasUserValue(field) && matchData.type !== 'correction') return fail(FILL_SKIPPED);
    const entries = toList(val);
    let targets = [];
    if (entries.length > 1) {
      // A real list (skills, languages): check only what we can prove.
      targets = resolveMultipleOptions(field.options, val).options;
      if (!targets.length) return fail(FILL_NO_OPTION, val);
    } else {
      // A scalar answer: treat it as a single yes/no within the group.
      const { option, reason } = resolveOption(field.options, val, matchData.type);
      if (!option) return fail(reason || FILL_NO_OPTION, val);
      targets = [option];
    }
    const wanted = new Set(targets.map(o => o.value));
    let allOk = true;
    for (const opt of field.options) {
      if (opt.disabled) continue;
      if (fillCheckbox(field, opt, wanted.has(opt.value)).status !== FILL_OK) allOk = false;
    }
    return allOk ? ok(targets.map(o => o.value)) : fail(FILL_FAILED, targets.map(o => o.value));
  }

  // ── Single-choice controls ──
  if (CHOICE_KINDS.has(kind)) {
    if (hasUserValue(field) && matchData.type !== 'correction') return fail(FILL_SKIPPED);

    // A custom dropdown is special: its options usually do not exist until the
    // list is opened, so we cannot pick a target up front. Hand the desired
    // text straight to the widget, which opens, reads and clicks.
    if (kind === FIELD_KIND.CUSTOM_DROPDOWN) {
      const desired = matchData.choose || (CHOICE_KINDS.has(kind) && typeof val === 'string' ? val : val);
      if (isDeferredOption(String(desired)) && !matchData.choose) return fail(FILL_DEFERRED, desired);
      return fillCustomDropdown(field, { text: String(desired), value: String(desired) }, matchData);
    }

    // An explicit `choose` from the option-aware LLM path wins.
    let target = null;
    if (matchData.choose) {
      target = resolveOption(field.options, matchData.choose, matchData.type).option;
    }
    if (!target) {
      const { option, reason } = resolveOption(field.options, val, matchData.type);
      if (!option) return fail(reason || FILL_NO_OPTION, val);
      target = option;
    }

    // A "none of the above" style pick is only safe if nothing better exists,
    // and never as a blanket default.
    if (isDeferredOption(target.text) && !matchData.choose) {
      return fail(FILL_DEFERRED, target.text);
    }

    if (kind === FIELD_KIND.RADIO) return fillRadio(field, target);
    if (kind === FIELD_KIND.CHECKBOX_SINGLE) return fillCheckbox(field, target, true);
    if (kind === FIELD_KIND.SELECT) return fillSelectOne(field, target);
    return fail(FILL_UNSUPPORTED, target.value);
  }

  // ── Plain text-ish inputs ──
  if (hasUserValue(field) && matchData.type !== 'correction') return fail(FILL_SKIPPED);
  const el = field.element;
  const text = Array.isArray(val) ? toList(val).join(', ') : String(val);
  if (kind === FIELD_KIND.NUMBER) {
    const n = coerceNumericValue(text);
    if (n === null) return fail(FILL_NO_VALUE, text);
    setNativeInputValue(el, String(n));
    blurToCommit(el);
    return String(el.value).trim() === String(n) ? ok(n) : fail(FILL_FAILED, n);
  }
  if (kind === FIELD_KIND.CUSTOM_DROPDOWN) return fail(FILL_UNSUPPORTED, text);
  setNativeInputValue(el, text);
  blurToCommit(el);
  if (String(el.value ?? '').trim() !== text.trim()) return fail(FILL_FAILED, text);
  return ok(text);
}

// ═══════════════════════════════════════
// CORRECTIONS DETECTOR
// ═══════════════════════════════════════

function isSensitiveField(label) {
  const lower = normalizeLabel(label);
  for (const rawKw of SENSITIVE_FIELD_KEYWORDS) {
    const kw = normalizeLabel(rawKw);
    if (!kw) continue;
    if (lower.includes(kw)) return true;
  }
  return false;
}

function sendCorrection(label, value) {
  chrome.runtime.sendMessage({
    action: 'save_correction',
    field_label: label,
    corrected_value: value,
    field_kind: 'value'
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
  const label = normalizeLabel(fieldLabelOf(field));
  if (!label) return;
  if (isSensitiveField(label)) return;
  if (el.type === 'password') return;

  const initial = filledValue === undefined || filledValue === null
    ? currentValueOf(field)
    : (Array.isArray(filledValue) ? filledValue.join(', ') : String(filledValue));

  filledFieldsMap.set(el, { label, filledValue: initial });

  if (el.dataset.formpilotTracked) return;
  el.dataset.formpilotTracked = 'true';

  const handler = () => {
    if (isAutoFilling) return;
    const raw = currentValueOf(field);
    const currentValue = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
    const tracked = filledFieldsMap.get(el);
    if (tracked && currentValue !== tracked.filledValue) {
      tracked.filledValue = currentValue;
      filledFieldsMap.set(el, tracked);
      if (!isSensitiveField(tracked.label)) sendCorrection(tracked.label, currentValue);
    }
  };

  el.addEventListener('blur', handler);
  el.addEventListener('change', handler);
  el.addEventListener('input', handler);
  // Choice widgets live in divs; they emit click, not change.
  if (CHOICE_KINDS.has(field.kind) || field.widgetRole === 'radiogroup' || field.widgetRole === 'checkboxgroup') {
    el.addEventListener('click', handler);
  }
}

// ═══════════════════════════════════════
// AUTOFILL ENGINE
// Bounded multi-pass loop: fill, let the DOM settle, collect what appeared,
// fill that too. Handles "Other → specify" and wizard steps.
// ═══════════════════════════════════════

function makeReport() {
  return {
    filled: 0,
    noOption: 0,
    noValue: 0,
    deferred: 0,
    unsupported: 0,
    skipped: 0,
    failed: 0,
    consent: 0,
    unmatched: 0,
    failures: []
  };
}

function recordResult(report, field, result) {
  switch (result.status) {
    case FILL_OK:
      report.filled++;
      return true;
    case FILL_SKIPPED:
      if (result.value === 'consent') { report.consent++; return false; }
      report.skipped++;
      return false;
    case FILL_NO_OPTION:
      report.noOption++;
      report.failures.push({ label: fieldLabelOf(field), kind: field.kind, status: result.status });
      return false;
    case FILL_NO_VALUE:
      report.noValue++;
      return false;
    case FILL_DEFERRED:
      report.deferred++;
      return false;
    case FILL_UNSUPPORTED:
      report.unsupported++;
      report.failures.push({ label: fieldLabelOf(field), kind: field.kind, status: result.status });
      return false;
    default:
      report.failed++;
      report.failures.push({ label: fieldLabelOf(field), kind: field.kind, status: result.status });
      return false;
  }
}

/** Resolve a field against profile + corrections, then fill it. */
async function processField(field, ctx) {
  const label = fieldLabelOf(field);
  const match = matchField(field, ctx.profile, ctx.corrections);

  if (match) {
    if (match.value === '' || match.value === null || match.value === undefined) {
      return { matched: false, label };
    }
    const result = await fillField(field, match);
    const success = recordResult(ctx.report, field, result);
    if (success) {
      trackFieldCorrections(field, result.value);
      applyHighlight(field.element, match.type === 'correction' ? 'medium' : 'high');
    }
    return { matched: true, filled: success, label };
  }

  // Not resolvable locally. Queue for the LLM pass unless it is off-limits.
  if (!label) return { matched: false, label: '' };
  if (isSensitiveField(label)) return { matched: false, label, blocked: 'sensitive' };
  if (field.element && field.element.type === 'password') return { matched: false, label, blocked: 'password' };
  if (isNativeDateInput(field)) return { matched: false, label, blocked: 'native-date' };
  if (field.isConsent) { ctx.report.consent++; return { matched: false, label, blocked: 'consent' }; }
  if (field.kind === FIELD_KIND.FILE) { ctx.report.unsupported++; return { matched: false, label, blocked: 'file' }; }

  ctx.pending.push({
    field,
    label,
    kind: field.kind,
    options: field.options.map(o => ({ value: o.value, text: o.text })).slice(0, 40)
  });
  return { matched: false, label, queued: true };
}

/** One LLM batch for everything queued this pass, then apply and fill. */
async function runLlmPass(ctx) {
  const queue = ctx.pending;
  ctx.pending = [];
  if (!queue.length) return;

  // Never ask the same question twice in one fill.
  const fresh = queue.filter(item => !ctx.llmCache.has(normalizeLabel(item.label)));
  if (!fresh.length) return;

  console.log(`[FormPilot] Requesting LLM mapping for ${fresh.length} fields:`, fresh.map(f => f.label));

  let mappings = null;
  try {
    const resp = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        action: 'match_fields',
        unmatched_fields: fresh.map(f => ({ label: f.label, kind: f.kind, options: f.options }))
      }, resolve);
    });
    if (resp && resp.success && resp.mappings) mappings = resp.mappings;
    else {
      const errMsg = (resp && resp.error) ? resp.error : JSON.stringify(resp);
      console.error('[FormPilot] Failed to get LLM mappings:', errMsg);
    }
  } catch (e) {
    console.error('[FormPilot] LLM Fallback failed:', e);
  }

  for (const item of fresh) {
    const norm = normalizeLabel(item.label);
    let entry = mappings ? (mappings[item.label] ?? lookupNormalized(mappings, item.label)) : undefined;

    if (entry === undefined || entry === null) {
      ctx.llmCache.set(norm, null);
      if (!fpSettings.autoDraftMode) injectSparkleIcon(item.field, item.label);
      else await autoDraft(item.field, item.label, ctx);
      continue;
    }

    // Accept both the option-aware shape {key, choose} and the legacy bare key.
    let key = entry;
    let choose = null;
    if (typeof entry === 'object' && entry !== null) {
      key = entry.key ?? entry.mapping ?? null;
      choose = entry.choose ?? entry.option ?? null;
    }
    ctx.llmCache.set(norm, { key, choose });

    if (!key) {
      if (fpSettings.autoDraftMode) await autoDraft(item.field, item.label, ctx);
      else injectSparkleIcon(item.field, item.label);
      continue;
    }

    let valueToFill = '';
    let fromResume = false;
    if (key.startsWith('profile.') && ctx.profile) {
      const k = key.split('.')[1];
      valueToFill = ctx.profile[k];
      console.log(`[FormPilot] Mapping "${item.label}" -> profile.${k} = "${valueToFill}"`);
    } else if (key.startsWith('resume.') && ctx.resume) {
      fromResume = true;
      const k = key.split('.')[1];
      const resumeVals = ctx.resume[k];
      valueToFill = Array.isArray(resumeVals) ? resumeVals.join('\n') : resumeVals;
      console.log(`[FormPilot] Mapping "${item.label}" -> resume.${k} = [len:${valueToFill ? String(valueToFill).length : 0}]`);
    }

    if (valueToFill === '' || valueToFill === null || valueToFill === undefined) {
      console.log(`[FormPilot] No data found in profile/resume for key: ${key}`);
      if (!fpSettings.autoDraftMode) injectSparkleIcon(item.field, item.label);
      continue;
    }

    const match = { value: valueToFill, type: 'llm', choose };
    const result = await fillField(item.field, match);
    const success = recordResult(ctx.report, item.field, result);
    if (success) {
      trackFieldCorrections(item.field, result.value);
      applyHighlight(item.field.element, fromResume ? 'draft' : 'medium');
      console.log(`[FormPilot] Filled "${item.label}" using LLM fallback.`);
    } else {
      console.warn(`[FormPilot] Could not fill "${item.label}" (${result.status}).`);
      if (!fpSettings.autoDraftMode) injectSparkleIcon(item.field, item.label);
    }
  }
}

function lookupNormalized(mappings, label) {
  const norm = normalizeLabel(label);
  for (const [k, v] of Object.entries(mappings)) {
    if (normalizeLabel(k) === norm) return v;
  }
  return undefined;
}

async function autoDraft(field, label, ctx) {
  try {
    const resp = await new Promise(resolve => {
      chrome.runtime.sendMessage({
        action: 'draft_answer',
        questions: [label],
        user_context: '',
        use_profile: true
      }, resolve);
    });
    if (!resp || !resp.success || !resp.drafts) return;
    const text = resp.drafts[label] ?? resp.drafts[Object.keys(resp.drafts).find(k => normalizeLabel(k) === normalizeLabel(label))];
    if (!text) return;
    const result = await fillField(field, { value: text, type: 'llm' });
    if (result.status === FILL_OK) {
      recordResult(ctx.report, field, result);
      trackFieldCorrections(field, text);
      applyHighlight(field.element, 'draft');
    }
  } catch (e) {
    console.error('[FormPilot] Auto-draft failed for', label, e);
  }
}

/** The full autofill run. */
async function runAutofill(message) {
  const ctx = {
    profile: message.profile || {},
    corrections: message.corrections || {},
    resume: message.resume || {},
    report: makeReport(),
    pending: [],
    llmCache: new Map()
  };

  const processed = new Set();
  isAutoFilling = true;

  try {
    for (let pass = 0; pass < MAX_AUTOFILL_PASSES; pass++) {
      const fields = collectFields();
      const fresh = fields.filter(f => {
        if (processed.has(f.element)) return false;
        processed.add(f.element);
        return true;
      });

      if (pass > 0) {
        if (!fresh.length) break;
        console.log(`[FormPilot] Pass ${pass + 1}: ${fresh.length} newly revealed field(s)`);
      }

      for (const field of fresh) {
        await processField(field, ctx);
      }

      await runLlmPass(ctx);

      if (pass < MAX_AUTOFILL_PASSES - 1) {
        await waitForDomSettle();
        // Stop early when nothing new appeared.
        const after = collectFields();
        const remaining = after.filter(f => !processed.has(f.element));
        if (!remaining.length) break;
      }
    }
  } finally {
    // Learn from fields we never touched too.
    for (const field of collectFields()) {
      if (!filledFieldsMap.has(field.element)) trackFieldCorrections(field, '');
    }
    isAutoFilling = false;
  }

  const r = ctx.report;
  return {
    success: true,
    matched: r.filled,
    filled: r.filled,
    needsReview: Math.max(0, r.noOption + r.noValue + r.deferred + r.failed + r.unsupported),
    report: {
      filled: r.filled,
      noOption: r.noOption,
      noValue: r.noValue,
      deferred: r.deferred,
      unsupported: r.unsupported,
      skipped: r.skipped,
      failed: r.failed,
      consent: r.consent,
      unmatched: r.unmatched,
      failures: r.failures.slice(0, 25)
    }
  };
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
        kind: f.kind,
        type: f.type,
        id: f.id,
        name: f.name,
        isCustomWidget: f.isCustomWidget,
        isConsent: !!f.isConsent,
        sectionContext: f.sectionContext,
        optionCount: f.options.length,
        currentValue: currentValueOf(f)
      }))
    });
    return true;
  }

  if (message.action === 'autofill') {
    if (!message.profile) {
      sendResponse({ success: false, error: 'No profile data received.' });
      return true;
    }
    runAutofill(message).then(result => {
      // Report to the SW so per-frame results aggregate into one badge.
      try { chrome.runtime.sendMessage({ action: 'autofill_done', report: result.report || {} }); } catch (e) { /* ignore */ }
      sendResponse(result);
    }).catch(err => {
      console.error('[FormPilot] Autofill failed:', err);
      isAutoFilling = false;
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'autofill_error') {
    console.error('[FormPilot]', message.error);
    sendResponse({ success: false, error: message.error });
    return true;
  }

  if (message.action === 'scroll_to_review') {
    const el = document.querySelector('[data-formpilot-highlight="medium"], [data-formpilot-highlight="draft"], .formpilot-sparkle, [data-formpilot-failed]');
    if (el) {
      const target = (el.classList && el.classList.contains('formpilot-sparkle') && el.fieldRef && el.fieldRef.element) ? el.fieldRef.element : el;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// ═══════════════════════════════════════
// INLINE AI ASSIST ("✨" sparkle)
// ═══════════════════════════════════════

let currentDraftField = null;
let currentSparkleEl = null;
const sparkleRegistry = []; // { sparkle, field, label, anchor }
let sparkleReposScheduled = false;

function getSparkleAnchor(field) {
  const el = field.element;
  if (!el) return null;
  if (field.isCustomWidget || CHOICE_KINDS.has(field.kind)) {
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
  const isTextLike = !field.isCustomWidget && !CHOICE_KINDS.has(field.kind) &&
    (anchor.tagName === 'INPUT' || anchor.tagName === 'TEXTAREA' || anchor.tagName === 'SELECT');
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
          const result = await fillField(currentDraftField, { value: draftedText, type: 'llm' });
          if (result.status === FILL_OK) {
            applyHighlight(currentDraftField.element, 'draft');
            trackFieldCorrections(currentDraftField, draftedText);
          }
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
  if (isNativeDateInput(field)) return;
  if (field.element.dataset.fpSparkle) return;
  field.element.dataset.fpSparkle = 'true';

  const anchor = getSparkleAnchor(field) || field.element;
  if (!field.isCustomWidget && !CHOICE_KINDS.has(field.kind) && (anchor.tagName === 'INPUT' || anchor.tagName === 'TEXTAREA')) {
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
