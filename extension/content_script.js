// ── FormPilot Content Script ──
// Scans the active page for fillable controls, matches them against the local
// profile, and fills only supported, unambiguous fields.

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════

const FormPilotAPI = globalThis.browser || globalThis.chrome;
const HIGHLIGHT_DURATION_MS = 2200;
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

function isControlDisabled(el) {
  return el.matches(':disabled') || Boolean(el.closest('[aria-disabled="true"]'));
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
      outline: 2px solid #000 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.12) !important;
    }
  `;
  document.head.appendChild(style);
}

function applyHighlight(el, level = 'high') {
  if (!el) return;
  el.setAttribute('data-formpilot-highlight', level);
  if (HIGHLIGHT_DURATION_MS > 0) {
    setTimeout(() => {
      el.removeAttribute('data-formpilot-highlight');
    }, HIGHLIGHT_DURATION_MS);
  }
}

// ═══════════════════════════════════════
// PLATFORM DETECTION
// ═══════════════════════════════════════

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
  const ids = el?.getAttribute('aria-labelledby');
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

// Native date/time inputs (browser calendar UI) need format-aware handling.
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
      disabled: isControlDisabled(o),
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
      disabled: isControlDisabled(o),
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
      disabled: isControlDisabled(r),
      selected: r.getAttribute('aria-checked') === 'true'
    }));
  }
  const inputRadios = el.querySelectorAll('input[type="radio"]');
  return Array.from(inputRadios).map(r => ({
    el: r,
    value: r.value || ownLabelOf(r),
    text: ownLabelOf(r) || r.value,
    disabled: isControlDisabled(r),
    selected: !!r.checked
  }));
}

/** Options for a role="group" of role="checkbox" (GForms checkboxes). */
function optionsFromCheckboxGroup(el) {
  return Array.from(el.querySelectorAll('[role="checkbox"]')).map(c => ({
    el: c,
    value: c.getAttribute('data-value') || c.textContent.trim(),
    text: c.textContent.trim(),
    disabled: isControlDisabled(c),
    selected: c.getAttribute('aria-checked') === 'true'
  }));
}

/** The label describing a single checkbox/radio, not its question. */
function ownLabelOf(input) {
  const label = getLabelByFor(input) || getWrappingLabel(input);
  if (label) return label;
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
function findGroupContainer(control, selector, members) {
  const countIn = node => members
    ? members.filter(member => node.contains(member)).length
    : node.querySelectorAll(selector).length;
  let node = control.parentElement;
  let depth = 0;
  let lastGood = null;
  while (node && node !== document.body && node !== document.documentElement && depth < 10) {
    const count = countIn(node);
    if (members ? count === members.length : count >= 2) {
      if (node.matches('fieldset, [role="group"], [role="radiogroup"]')) return node;
      const parent = node.parentElement;
      const parentCount = parent ? countIn(parent) : 0;
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
      disabled: isControlDisabled(r) || !isVisible(r),
      selected: !!r.checked
    }))
    : (groupEl ? optionsFromRadioGroup(groupEl) : []);

  if (!options.length) return null;

  const label = opts.label || resolveRadioGroupLabel(groupEl, radios, options);
  const el = opts.anchor || radios?.[0] || groupEl;
  const container = groupEl || el;
  return {
    element: el,
    optionsEl: container,
    groupKey: opts.groupKey || '',
    kind: FIELD_KIND.RADIO,
    type: 'radio',
    tagName: el.tagName,
    id: container.id || el.id || '',
    name: radios && radios[0] ? (radios[0].getAttribute('name') || '') : '',
    placeholder: '',
    labelText: label,
    ariaLabel: getAriaLabel(container),
    sectionContext: resolveGroupSection(container, label),
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
    disabled: isControlDisabled(b),
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
  if (inputs.length !== 3 || inputs.some(el => !isVisible(el) || isControlDisabled(el) || el.readOnly)) return null;
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
    case FIELD_KIND.SELECT:
      return el.value ? (el.selectedOptions[0]?.textContent.trim() || el.value) : '';
    case FIELD_KIND.MULTI_SELECT:
      return Array.from(el.selectedOptions || []).map(o => o.textContent.trim() || o.value);
    case FIELD_KIND.CHECKBOX_MULTI:
      return field.options.filter(optionIsSelected).map(o => o.text || o.value);
    case FIELD_KIND.RADIO:
    case FIELD_KIND.CHECKBOX_SINGLE: {
      const option = field.options.find(optionIsSelected);
      return option ? (option.text || option.value) : '';
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

function fieldValueKey(field, value) {
  const { kind, element: el } = field;
  if (kind === FIELD_KIND.SELECT || kind === FIELD_KIND.MULTI_SELECT) {
    return JSON.stringify([value, Array.from(el.selectedOptions, option => option.index)]);
  }
  if (kind === FIELD_KIND.RADIO || kind === FIELD_KIND.CHECKBOX_SINGLE || kind === FIELD_KIND.CHECKBOX_MULTI) {
    const selected = field.options.flatMap((option, index) => optionIsSelected(option) ? [index] : []);
    return JSON.stringify([value, selected]);
  }
  return JSON.stringify(value);
}

/**
 * Whether this control already holds a value the *user* put there.
 * A repeat fill may replace its own value only while the control still holds
 * that value and has not been edited by the user.
 */
function hasUserValue(field) {
  const value = currentValueOf(field);
  if ((Array.isArray(value) ? !value.length : !String(value).trim()) ||
      (field.kind === FIELD_KIND.DATE_PARTS && value === '//')) return false;
  return filledFieldsMap.get(field.element)?.autofilled !== fieldValueKey(field, value);
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
      const name = r.getAttribute('name') || '';
      if (!name) continue;
      const owner = r.form || r.getRootNode();
      if (!radioGroups.has(owner)) radioGroups.set(owner, new Map());
      const groups = radioGroups.get(owner);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
      claimed.add(r);
    }
    for (const groups of radioGroups.values()) {
      for (const [name, group] of groups) {
        const visible = group.find(r => !isControlDisabled(r) && isVisible(r));
        if (!visible) continue;
        const container = findGroupContainer(visible, 'input[type="radio"]', group);
        const field = buildRadioField(container, group, { groupKey: name, anchor: visible });
        if (field) fields.push(field);
      }
    }
    // Radios with no shared name: each is its own single-option question.
    for (const r of radios) {
      if (claimed.has(r) || isControlDisabled(r) || !isVisible(r)) continue;
      claimed.add(r);
      const field = buildRadioField(null, [r], { groupKey: `solo:${r.id || Math.random()}` });
      if (field) fields.push(field);
    }

    // ── Pass 2: checkboxes → consent boxes, data groups, singletons ──
    const boxes = deepQueryAll(document, 'input[type="checkbox"]');
    const boxGroups = new Map();
    for (const b of boxes) {
      if (isControlDisabled(b) || !isVisible(b)) continue;
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
      if (isControlDisabled(el)) continue;
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
      if (isControlDisabled(el)) continue;
      // An individual ARIA radio/checkbox is collected as part of its group
      // container, never on its own — otherwise it appears twice.
      if ((el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch')
        && el.closest('[role="radiogroup"], [role="group"]')) continue;
      // Skip a wrapper that merely contains a real, already-claimed control.
      if (el.querySelector('input, select, textarea:not([readonly])')) {
        const inner = el.querySelector('input, select, textarea');
        if (inner && !inner.readOnly && !isControlDisabled(inner)) continue;
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
      if (isControlDisabled(el) || el.readOnly) continue;
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
      if (isControlDisabled(el) || el.readOnly) continue;
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

let currentPlatform = 'generic';

function getAdapter() {
  switch (currentPlatform) {
    case 'google-forms': return GFormsAdapter;
    case 'ms-forms': return MSFormsAdapter;
    default: return GenericAdapter;
  }
}

function collectFields() {
  return getAdapter().collectFields();
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

  // A bare "Name" is too context dependent without a personal/applicant cue.
  if (label === 'name' && !/\b(applicant|candidate|personal|your details|contact details)\b/.test(section)) return null;

  // Hard block: fields that belong to someone else, regardless of section.
  for (const neg of HARD_NEGATIVE_LABEL_KEYWORDS) {
    if (labelHasToken(label, neg)) return null;
  }
  // These labels are ambiguous about whose information is requested, even if
  // the page does not expose a useful section heading.
  for (const neg of SOFT_NEGATIVE_LABEL_KEYWORDS) {
    if (labelHasToken(label, normalizeLabel(neg))) return null;
  }

  // Consent / attestation boxes are never matched to profile data.
  if (field.isConsent) return null;

  // 1. A correction is reusable on any site for a matching label.
  if (Array.isArray(corrections)) {
    const correction = corrections.find(item => item
      && normalizeLabel(item.field_label) === label);
    if (correction) return { type: 'correction', value: correction.corrected_value, domain: correction.domain };
  }
  if (label === 'name') {
    const value = getProfileValue(FIELD_TYPES.FULL_NAME, profile);
    return value ? { type: FIELD_TYPES.FULL_NAME, value } : null;
  }

  // 2. Signatures (case-insensitive + punctuation-insensitive)
  const normName = normalizeSig(field.name || '');
  const normId = normalizeSig(field.id || '');
  for (const [sig, type] of Object.entries(FIELD_SIGNATURES)) {
    const normSig = normalizeSig(sig);
    if (!normSig) continue;
    if (normName === normSig || normId === normSig) {
      const value = getProfileValue(type, profile);
      // An empty profile value is a miss, not something to write into the form.
      if (value === '' || value === null || value === undefined) return null;
      return { type, value };
    }
  }

  // 3. Keyword mapping. All candidates are scored and the MOST SPECIFIC
  //    keyword wins, rather than whichever field type happens to be declared
  //    first. Without this, "Total experience in months" matched the generic
  //    "experience" keyword and was answered with years.
  const labelExact = label;
  const candidates = [];
  for (const [type, keywords] of Object.entries(FIELD_KEYWORDS)) {
    for (const rawKw of keywords) {
      const kw = normalizeLabel(rawKw);
      if (!kw) continue;
      if (!labelHasToken(label, kw)) continue;
      // Longest keyword wins; an exact whole-label match outranks a partial one.
      const score = (labelExact === kw ? 10000 : 0) + kw.length;
      candidates.push({ type, kw, score });
    }
  }
  if (candidates.length) {
    const bestScore = Math.max(...candidates.map(candidate => candidate.score));
    const bestTypes = new Set(candidates
      .filter(candidate => candidate.score === bestScore)
      .map(candidate => candidate.type));
    if (bestTypes.size !== 1) return null;
    const best = candidates.find(candidate => candidate.score === bestScore);
    const value = getProfileValue(best.type, profile);
    // An empty profile value is a miss, not something to write into the form.
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
const FILL_AMBIGUOUS = 'ambiguous';
const FILL_NO_VALUE = 'no-value';
const FILL_DEFERRED = 'deferred';
const FILL_UNSUPPORTED = 'unsupported';
const FILL_SKIPPED = 'skipped-existing';
const FILL_INVALID = 'invalid';
const FILL_FAILED = 'failed';

function ok(value) { return { status: FILL_OK, value }; }
function fail(status, value) { return { status, value: value === undefined ? null : value }; }

function canUseNativeValue(el, value) {
  if (!el.validity || typeof value !== 'string') return false;
  const probe = el.cloneNode(false);
  probe.value = value;
  return probe.validity.valid && probe.value.trim() === value.trim()
    && (!(probe.maxLength >= 0) || value.length <= probe.maxLength);
}

function fillNativeValue(el, value) {
  if (!canUseNativeValue(el, value)) return fail(FILL_INVALID);
  const before = el.value;
  setNativeInputValue(el, value);
  blurToCommit(el);
  if (el.validity.valid && el.value.trim() === value.trim()) return ok(value);
  setNativeInputValue(el, before);
  return fail(FILL_FAILED);
}

function setSelectOptions(el, wanted) {
  if (el.multiple) {
    for (const option of el.options) option.selected = wanted.has(option);
  } else {
    el.selectedIndex = Array.from(el.options).findIndex(option => wanted.has(option));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  blurToCommit(el);
}

function fillSelect(field, options) {
  const el = field.element;
  const before = new Set(el.selectedOptions);
  const wanted = new Set(options.map(option => option.el));
  setSelectOptions(el, wanted);
  const selected = Array.from(el.selectedOptions);
  if (el.validity.valid && selected.length === wanted.size && selected.every(option => wanted.has(option))) {
    return ok();
  }
  setSelectOptions(el, before);
  return fail(FILL_FAILED);
}

/** Check exactly one radio in a group. */
function fillRadio(field, option) {
  const target = option.el;
  if (!target || isControlDisabled(target)) return fail(FILL_UNSUPPORTED);

  const before = field.options.find(optionIsSelected);
  if (target.tagName === 'INPUT') {
    forceChecked(target, true);
    blurToCommit(target);
  } else if (before !== option) {
    userClick(target);
  }

  const selected = field.options.filter(optionIsSelected);
  if (selected.length === 1 && selected[0] === option) return ok();
  if (before?.el.tagName === 'INPUT') forceChecked(before.el, true);
  else if (before) userClick(before.el);
  else if (target.tagName === 'INPUT') target.checked = false;
  return fail(FILL_FAILED);
}

/** Set a checkbox (or checkbox group) to an exact checked/unchecked state. */
function fillCheckbox(option, shouldBeChecked) {
  const target = option.el;
  if (!target || isControlDisabled(target)) return fail(FILL_UNSUPPORTED);
  if (target.tagName === 'INPUT') {
    const before = target.checked;
    forceChecked(target, shouldBeChecked);
    if (target.checked === shouldBeChecked) return ok(shouldBeChecked ? option.value : '');
    forceChecked(target, before);
    return fail(FILL_FAILED, option.value);
  }
  const isChecked = () => target.getAttribute('aria-checked') === 'true' || (target.querySelector && !!target.querySelector('input:checked'));
  const before = isChecked();
  if (isChecked() !== shouldBeChecked) userClick(target);
  if (isChecked() === shouldBeChecked) return ok(shouldBeChecked ? option.value : '');
  if (isChecked() !== before) userClick(target);
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
  const parts = Object.entries(field.dateParts);
  if (parts.some(([role, input]) => isControlDisabled(input) || !canUseNativeValue(input, normalized[role]))) {
    return fail(FILL_INVALID);
  }
  const before = parts.map(([, input]) => input.value);
  for (const [role, input] of parts) {
    setNativeInputValue(input, normalized[role]);
    blurToCommit(input);
  }
  if (parts.every(([role, input]) => input.validity.valid && input.value.trim() === normalized[role])) return ok();
  parts.forEach(([, input], index) => setNativeInputValue(input, before[index]));
  return fail(FILL_FAILED, rawValue);
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

  return fillNativeValue(el, normalized);
}

function calendarViewMatches(popup, parts) {
  const title = popup.querySelector('.flatpickr-current-month, [data-calendar-title], [role="heading"]');
  const text = title ? String(title.textContent || '').trim() : '';
  const match = text.match(/([a-z]{3,9})\s+(\d{4})/i);
  if (!match) return false;
  const month = MONTH_NAMES[match[1].toLowerCase()];
  return month === parts.m && Number(match[2]) === parts.y;
}

function pickerOptionMatches(option, parts, viewMatches) {
  const node = option.el;
  const explicitDate = node.getAttribute('data-date') || node.getAttribute('aria-label');
  if (explicitDate) {
    const parsed = parseDateParts(explicitDate);
    if (parsed && !parsed.ambiguous) {
      return parsed.y === parts.y && parsed.m === parts.m && parsed.d === parts.d;
    }
  }
  return viewMatches && /^\d{1,2}$/.test(option.text.trim()) && Number(option.text.trim()) === parts.d;
}

/** Fill a date picker only when its displayed month/year and selected day agree. */
async function fillPickerDate(field, rawValue) {
  const expected = normalizeDateValue(rawValue, FIELD_KIND.DATE, field.dateOrder);
  const parts = expected && parseDateParts(expected);
  if (!parts) return fail(FILL_NO_VALUE, rawValue);

  const input = field.element;
  const before = snapshotVisiblePopups();
  openDropdown(input);
  const popup = pickOpenedPopup(input, before, null);
  if (!popup) {
    closeDropdown(input);
    return fail(FILL_NO_OPTION, rawValue);
  }

  const viewMatches = calendarViewMatches(popup, parts);
  const candidates = readPopupOptions(popup).filter(option => pickerOptionMatches(option, parts, viewMatches));
  if (candidates.length !== 1 || candidates[0].disabled) {
    closeDropdown(input);
    return fail(candidates.length > 1 ? FILL_AMBIGUOUS : FILL_NO_OPTION, rawValue);
  }

  userClick(candidates[0].el);
  await sleep(60);
  closeDropdown(input);
  const actual = normalizeDateValue(input.value, FIELD_KIND.DATE, field.dateOrder);
  if (actual === expected) return ok(expected);
  setNativeInputValue(input, '');
  return fail(FILL_FAILED, rawValue);
}

function optionReadbackMatches(shown, option) {
  const actual = normalizeOptionText(shown);
  if (!actual) return false;
  return actual === normalizeOptionText(option.text)
    || actual === normalizeOptionText(option.value);
}

function optionIsSelected(option) {
  const node = option && option.el;
  return !!node && (node.selected === true || node.checked === true
    || node.getAttribute('aria-selected') === 'true'
    || node.getAttribute('aria-checked') === 'true'
    || Boolean(node.querySelector('input:checked, [aria-checked="true"]')));
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
      if (optionReadbackMatches(shown, hit)) return ok(hit.value || hit.text);
      if (!shown && optionIsSelected(hit)) return ok(hit.value || hit.text);
      return fail(FILL_FAILED, shown || desiredText);
    }
    closeDropdown(trigger);
    return fail(reason === 'deferred' ? FILL_DEFERRED
      : reason === 'ambiguous' ? FILL_AMBIGUOUS : FILL_NO_OPTION, desiredText);
  }

  // A keyboard-only list is supported only when its options were collected
  // and one uniquely matched option can be verified after selection.
  const statics = field.options || [];
  if (statics.length) {
    const { option: hit, reason } = resolveOption(statics, desiredText, matchData && matchData.type);
    if (hit) {
      userClick(hit.el);
      await sleep(40);
      const shown = readTriggerValue(trigger) || trigger.getAttribute('data-value') || '';
      if (optionReadbackMatches(shown, hit)) return ok(hit.value || hit.text);
      if (!shown && optionIsSelected(hit)) return ok(hit.value || hit.text);
      return fail(FILL_FAILED, shown || desiredText);
    }
    if (reason === 'ambiguous') return fail(FILL_AMBIGUOUS, desiredText);
  }
  closeDropdown(trigger);
  return fail(FILL_NO_OPTION, desiredText);
}

function resolveFieldChoices(field, match) {
  const options = field.options.filter(option => !isControlDisabled(option.el));
  const entries = toList(match.value);
  if (field.kind === FIELD_KIND.MULTI_SELECT || (field.kind === FIELD_KIND.CHECKBOX_MULTI && entries.length > 1)) {
    const { options: matches } = resolveMultipleOptions(options, entries);
    return { targets: matches.filter(option => !isDeferredOption(option.text)), reason: FILL_NO_OPTION };
  }
  const { option, reason } = resolveOption(options, match.value, match.type);
  if (!option) return { targets: [], reason };
  if (isDeferredOption(option.text)) return { targets: [], reason: FILL_DEFERRED };
  return { targets: [option] };
}

function fillCheckboxGroup(field, targets) {
  const wanted = new Set(targets.map(option => option.el));
  const before = new Set(field.options.filter(optionIsSelected));
  const verify = () => field.options.every(option => optionIsSelected(option) === wanted.has(option.el));
  for (const option of field.options) {
    const checked = wanted.has(option.el);
    if (optionIsSelected(option) !== checked && fillCheckbox(option, checked).status !== FILL_OK) break;
  }
  if (verify()) return ok();
  for (const option of field.options) {
    if (optionIsSelected(option) !== before.has(option)) fillCheckbox(option, before.has(option));
  }
  return fail(FILL_FAILED);
}

function textForControl(kind, value) {
  const text = Array.isArray(value) ? toList(value).join(', ') : String(value);
  if (kind !== FIELD_KIND.NUMBER) return text;
  const number = coerceNumericValue(text);
  return number === null ? '' : String(number);
}

function hasSavedValue(match) {
  return match?.value != null && (Array.isArray(match.value)
    ? toList(match.value).length > 0
    : String(match.value).trim() !== '');
}

async function fillField(field, matchData) {
  if (!hasSavedValue(matchData)) return fail(FILL_NO_VALUE);

  const { kind, element: el } = field;
  const val = matchData.value;
  if (kind === FIELD_KIND.FILE || isControlDisabled(el)) return fail(FILL_UNSUPPORTED);
  if (field.isConsent) return fail(FILL_SKIPPED, 'consent');
  if (hasUserValue(field)) return fail(FILL_SKIPPED);

  // ── Rich text ──
  if (kind === FIELD_KIND.RICH_TEXT) {
    return fillRichText(field, val);
  }

  // ── Dates ──
  if (DATE_KINDS.has(kind)) {
    return kind === FIELD_KIND.DATE_PARTS ? fillDateParts(field, val) : fillDateField(field, val);
  }

  // Custom widgets may not render their options until opened.
  if (kind === FIELD_KIND.CUSTOM_DROPDOWN) {
    const desired = String(val);
    if (isDeferredOption(desired)) return fail(FILL_DEFERRED);
    return fillCustomDropdown(field, { text: desired, value: desired }, matchData);
  }

  if (CHOICE_KINDS.has(kind)) {
    const { targets, reason } = resolveFieldChoices(field, matchData);
    if (!targets.length) return fail(reason || FILL_NO_OPTION);
    if (kind === FIELD_KIND.RADIO) return fillRadio(field, targets[0]);
    if (kind === FIELD_KIND.CHECKBOX_SINGLE) return fillCheckbox(targets[0], true);
    if (kind === FIELD_KIND.CHECKBOX_MULTI) return fillCheckboxGroup(field, targets);
    return fillSelect(field, targets);
  }

  if (!el.validity || el.readOnly) return fail(FILL_UNSUPPORTED);
  const text = textForControl(kind, val);
  return text ? fillNativeValue(el, text) : fail(FILL_INVALID);
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

function trackFieldCorrections(field, generation, match) {
  const el = field.element;
  const label = normalizeLabel(fieldLabelOf(field));
  if (!label || isSensitiveField(label) || el.type === 'password') return;
  const previous = filledFieldsMap.get(el);
  const snapshot = fieldValueKey(field, currentValueOf(field));
  filledFieldsMap.set(el, {
    field, label, snapshot, generation, domain: match?.domain,
    autofilled: match ? snapshot : undefined
  });
  if (previous) return;

  const handler = event => {
    if (isAutoFilling || !event.isTrusted) return;
    const tracked = filledFieldsMap.get(el);
    const raw = currentValueOf(tracked.field);
    const current = fieldValueKey(tracked.field, raw);
    if (current === tracked.snapshot) return;
    tracked.snapshot = current;
    tracked.autofilled = undefined;
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (!value.trim() || (tracked.field.kind === FIELD_KIND.DATE_PARTS && value === '//')) return;
    FormPilotAPI.runtime.sendMessage({
      action: 'save_correction',
      field_label: tracked.label,
      corrected_value: value,
      field_kind: CHOICE_KINDS.has(tracked.field.kind) ? 'option' : 'value',
      domain: tracked.domain,
      generation: tracked.generation
    }).catch(() => console.warn('[FormPilot] Could not save a correction locally.'));
  };

  if (CHOICE_KINDS.has(field.kind) || field.kind === FIELD_KIND.DATE_PARTS) {
    const targets = new Set([field.optionsEl, ...field.options.map(option => option.el)]);
    for (const target of targets) target.addEventListener('change', handler);
    field.optionsEl.addEventListener('click', handler);
  } else if (field.kind === FIELD_KIND.RICH_TEXT) {
    let edited = false;
    el.addEventListener('input', event => { if (event.isTrusted && !isAutoFilling) edited = true; });
    el.addEventListener('blur', event => {
      if (edited) handler(event);
      edited = false;
    });
  } else {
    el.addEventListener('change', handler);
  }
}

// ═══════════════════════════════════════
// AUTOFILL ENGINE
// Bounded multi-pass loop: fill, let the DOM settle, collect what appeared,
// fill that too. Handles "Other → specify" and wizard steps.
// ═══════════════════════════════════════

function makeReport() {
  return {
    totalFields: 0,
    filled: 0,
    ambiguous: 0,
    noOption: 0,
    noValue: 0,
    deferred: 0,
    unsupported: 0,
    skipped: 0,
    failed: 0,
    consent: 0,
    blocked: 0,
    unmatched: 0,
    details: []
  };
}

function addFieldDetail(report, field, status, reason = '', source = '') {
  if (report.details.length >= 50) return;
  report.details.push({
    label: fieldLabelOf(field) || 'Unlabeled field',
    status,
    reason,
    source
  });
}

function recordResult(report, field, result, source = '') {
  switch (result.status) {
    case FILL_OK:
      report.filled++;
      addFieldDetail(report, field, 'filled', '', source);
      return true;
    case FILL_SKIPPED:
      if (result.value === 'consent') {
        report.consent++;
        addFieldDetail(report, field, 'skipped', 'Agreement left for your review.');
        return false;
      }
      report.skipped++;
      addFieldDetail(report, field, 'skipped', 'This field already has a value.');
      return false;
    case FILL_NO_OPTION:
      report.noOption++;
      addFieldDetail(report, field, 'skipped', 'No supported option matched the saved value.');
      return false;
    case FILL_AMBIGUOUS:
      report.ambiguous++;
      addFieldDetail(report, field, 'skipped', 'More than one option matched.');
      return false;
    case FILL_NO_VALUE:
      report.noValue++;
      addFieldDetail(report, field, 'skipped', 'No saved value was available.');
      return false;
    case FILL_DEFERRED:
      report.deferred++;
      addFieldDetail(report, field, 'skipped', 'This answer needs a manual follow-up.');
      return false;
    case FILL_UNSUPPORTED:
      report.unsupported++;
      addFieldDetail(report, field, 'skipped', 'This control needs manual input.');
      return false;
    case FILL_INVALID:
      report.unsupported++;
      addFieldDetail(report, field, 'skipped', 'The saved value does not meet this field’s requirements.');
      return false;
    default:
      report.failed++;
      addFieldDetail(report, field, 'failed', 'FormPilot could not verify the result.');
      return false;
  }
}

/** Resolve a field using only locally stored profile values and corrections. */
async function processField(field, ctx) {
  const label = fieldLabelOf(field);
  const report = ctx.report;
  report.totalFields++;

  if (!label) {
    report.unmatched++;
    addFieldDetail(report, field, 'skipped', 'No readable field label was found.');
    return;
  }
  const passwordField = field.element && field.element.type === 'password';
  const sensitiveField = isSensitiveField(label) || passwordField;
  if (sensitiveField) {
    report.blocked++;
    addFieldDetail(report, field, 'skipped', 'Sensitive fields are never autofilled.');
    return;
  }
  if (field.isConsent) {
    report.consent++;
    addFieldDetail(report, field, 'skipped', 'Agreement left for your review.');
    return;
  }
  if (field.kind === FIELD_KIND.FILE) {
    report.unsupported++;
    addFieldDetail(report, field, 'skipped', 'File uploads need manual input.');
    return;
  }

  const match = matchField(field, ctx.profile, ctx.corrections);
  if (!hasSavedValue(match)) {
    report.unmatched++;
    addFieldDetail(report, field, 'skipped', 'No unique supported profile match was found.');
    if (!hasUserValue(field)) trackFieldCorrections(field, ctx.generation);
    return;
  }

  const result = await fillField(field, match);
  const source = match.type === 'correction' ? 'Learned correction' : 'Profile';
  if (recordResult(report, field, result, source)) {
    trackFieldCorrections(field, ctx.generation, match);
    applyHighlight(field.element, 'high');
  }
}

/** The full autofill run. */
async function runAutofill(message) {
  injectHighlightStyles();
  const ctx = {
    profile: message.profile || {},
    corrections: Array.isArray(message.corrections) ? message.corrections : [],
    generation: message.generation,
    report: makeReport()
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

      if (pass < MAX_AUTOFILL_PASSES - 1) {
        await waitForDomSettle();
        // Stop early when nothing new appeared.
        const after = collectFields();
        const remaining = after.filter(f => !processed.has(f.element));
        if (!remaining.length) break;
      }
    }
  } finally {
    isAutoFilling = false;
  }

  return { success: true, report: ctx.report };
}

// ═══════════════════════════════════════
// DETECTION — report what could be filled, without changing the page
// ═══════════════════════════════════════

function canFillField(field, match) {
  const { kind, element: el } = field;
  if (kind === FIELD_KIND.CUSTOM_DROPDOWN) return !isDeferredOption(String(match.value));
  if (CHOICE_KINDS.has(kind)) return resolveFieldChoices(field, match).targets.length > 0;
  if (kind === FIELD_KIND.RICH_TEXT) return true;
  if (DATE_KINDS.has(kind)) {
    const value = normalizeDateValue(match.value, kind, field.dateOrder);
    if (!value) return false;
    if (kind === FIELD_KIND.DATE_PARTS) {
      return Object.entries(field.dateParts).every(([role, part]) =>
        !isControlDisabled(part) && canUseNativeValue(part, value[role]));
    }
    return el.readOnly || canUseNativeValue(el, value);
  }
  const text = textForControl(kind, match.value);
  return Boolean(text && el.validity && !el.readOnly && canUseNativeValue(el, text));
}

function detectPageFields(message) {
  const profile = message.profile || {};
  const corrections = Array.isArray(message.corrections) ? message.corrections : [];
  let supportedFields = 0;
  let matchedFields = 0;
  let existingFields = 0;

  for (const field of collectFields()) {
    const label = fieldLabelOf(field);
    if (!label) continue;
    if (field.element && field.element.type === 'password') continue;
    if (isSensitiveField(label)) continue;
    if (field.isConsent || isControlDisabled(field.element)) continue;
    if (field.kind === FIELD_KIND.FILE) continue;

    supportedFields++;
    const match = matchField(field, profile, corrections);
    if (!hasSavedValue(match)) continue;
    if (hasUserValue(field)) existingFields++;
    else if (canFillField(field, match)) matchedFields++;
  }

  return { success: true, supportedFields, matchedFields, existingFields };
}

FormPilotAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== FormPilotAPI.runtime.id || sender.tab || message?.origin !== window.origin) return false;
  if (message.action === 'detect') {
    sendResponse(detectPageFields(message));
    return false;
  }
  if (message.action === 'autofill') {
    runAutofill(message).then(sendResponse).catch(() => {
      sendResponse({ success: false, error: 'FormPilot could not complete the fill.' });
    });
    return true;
  }
  return false;
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

(function init() {
  currentPlatform = detectFormPlatform(window.location);
  globalThis.formPilotContentReady = true;
})();
