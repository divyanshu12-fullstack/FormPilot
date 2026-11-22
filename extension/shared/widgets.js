// ── FormPilot Widget Layer ──
// DOM mechanics for controls that are not plain <input>/<select>:
// custom dropdowns, picker popups, shadow DOM, and deep option reading.
// Loaded after constants.js, before content_script.js.

// ═══════════════════════════════════════
// DEEP QUERY — sees through open shadow roots
// ═══════════════════════════════════════

/**
 * querySelectorAll that also descends into open shadow roots.
 * Closed roots stay invisible (documented limitation).
 */
function deepQueryAll(root, selector, out = [], depth = 0) {
  if (!root || depth > 12) return out;
  let found = [];
  try {
    found = Array.from(root.querySelectorAll(selector)); } catch (e) { return out; }
  for (const el of found) out.push(el);

  // Only descend into real shadow hosts, so the cost stays one '*' sweep per
  // nesting level rather than one per element.
  let all = [];
  try { all = Array.from(root.querySelectorAll('*')); } catch (e) { all = []; }
  for (const el of all) {
    if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out, depth + 1);
  }
  return out;
}

/** True when the element lives inside an open shadow root. */
function inShadowRoot(el) {
  let node = el;
  while (node) {
    if (node.parentNode === null && node.host) return true;
    node = node.parentNode;
  }
  return false;
}

/** Deep-activeElement — document.activeElement stops at the shadow boundary. */
function deepActiveElement() {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/** Does this element live inside a shadow root we cannot reach? */
function isInClosedShadow(el) {
  let node = el;
  while (node && node.parentNode) {
    if (node.parentNode === document || node.parentNode === document.body) return false;
    node = node.parentNode;
  }
  // Reached the top without passing through document → we are in a root we
  // cannot inspect, which for our purposes means closed.
  return node !== document && node !== document.documentElement;
}

// ═══════════════════════════════════════
// VISIBILITY — shadow-aware
// ═══════════════════════════════════════

function isElementVisible(el) {
  if (!el) return false;
  if (el.nodeType !== Node.ELEMENT_NODE) return false;
  // offsetParent is null for display:none; also covers most hidden ancestors.
  if (el.offsetParent === null && el.getClientRects().length === 0) {
    // position:fixed elements have null offsetParent but are visible
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.display === 'none') return false;
  }
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  if (style.opacity !== '' && parseFloat(style.opacity) < 0.05) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ═══════════════════════════════════════
// WIDGET FAMILIES
// Each custom dropdown on the web is one of a handful of shapes. We detect
// the family from a DOM fingerprint, then use the matching open/select route.
// ═══════════════════════════════════════

const POPUP_SELECTORS = [
  '[role="listbox"]',
  '.select2-dropdown',
  '.dropdown-menu',
  '.MuiMenu-list',
  '.MuiPopover-root',
  '.select2-results__options',
  '.select__menu',
  '.ss-menu',
  '.rc-virtual-list',
  '.flatpickr-calendar',
  '.datepicker',
  '.ui-menu',
  '.dropdown-container',
  '[class*="dropdown" i][class*="menu" i]',
  '[class*="popup" i]',
  '[class*="popover" i]',
  '[class*="suggest" i]',
  '[class*="autocomplete" i][class*="list" i]',
  '[class*="options" i][class*="list" i]'
];

const OPTION_SELECTORS = [
  '[role="option"]',
  'li',
  '.select2-results__option',
  '.dropdown-item',
  '.MuiMenuItem-root',
  '.select__option',
  '.ss-option',
  '.rc-virtual-list-item',
  '.flatpickr-day',
  '.ui-menu-item',
  '.option',
  '[data-value]'
];

const TRIGGER_SELECTORS = [
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="true"]',
  '[role="combobox"]',
  '.MuiSelect-select',
  '.MuiNativeSelect-select',
  '.select2-selection',
  '.chosen-container',
  '.select2-container',
  '.dropdown-toggle',
  '.select__control',
  '.ss__control',
  '.v-select',
  '.dx-dropdown-button',
  '.ant-select-selector',
  '.ant-select',
  '.multiselect-select',
  '.flatpickr-input',
  '.datepicker-input',
  '[class*="select" i][class*="control" i]',
  '[class*="select" i][class*="dropdown" i]'
];

function isTriggerElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (TRIGGER_SELECTORS.some(sel => { try { return el.matches(sel); } catch (e) { return false; } })) return true;
  return false;
}

function looksLikeTrigger(el) {
  if (!el) return false;
  if (isTriggerElement(el)) return true;
  // Framework wrappers: react-select / select2 place a hidden input inside.
  try {
    if (el.querySelector('input[type="hidden"]') && (el.hasAttribute('aria-haspopup') || el.getAttribute('role') === 'combobox')) return true;
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * Text a dropdown shows before anything is chosen.
 *
 * Getting this wrong is costly: a trigger still reading "Select…" would look
 * like a field the user had already filled, and the autofill would skip it.
 * So placeholders are matched against an explicit list plus a
 * "placeholder verb and nothing else" rule.
 */
const DROPDOWN_PLACEHOLDER_TEXTS = new Set([
  'select', 'choose', 'select an option', 'choose an option', 'choose an item',
  'select item', 'select an item', 'please select', 'any', 'search', 'none',
  'n/a', 'option', 'options', 'start typing', 'filter', 'click to select',
  'tap to select', 'pick one', 'select one', 'no selection', 'none selected',
  'select...', 'choose...', 'please select...', 'select an option...'
]);

function looksLikePlaceholder(text) {
  const t = String(text === null || text === undefined ? '' : text)
    .replace(/[\u2026\u00b7]+$/g, '')  // trailing ellipsis / middot
    .replace(/[.\s]+$/g, '')
    .trim()
    .toLowerCase();
  if (!t) return true;
  if (DROPDOWN_PLACEHOLDER_TEXTS.has(t)) return true;
  // "Select…" → "select"; "Choose:" → "choose". Nothing but filler after the verb.
  return /^(select|choose|pick|enter|search|filter|start typing|click to|tap to)\b[^a-z]*$/.test(t);
}

/** The visible text a trigger currently displays, or '' when it is a placeholder. */
function readTriggerValue(el) {
  if (!el) return '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const v = (el.value || '').trim();
    return looksLikePlaceholder(v) ? '' : v;
  }
  const shown = el.querySelector(
    '.tpl-value, .select2-selection__rendered, .select__single-value, .ss-single-value, ' +
    '[class*="single-value" i], [class*="placeholder" i]'
  );
  const direct = shown ? shown.textContent.trim() : el.textContent.trim();
  if (!direct) return '';
  // Only the FIRST line matters: a trigger that wraps its own hidden option
  // list would otherwise report every option as its value.
  const firstLine = direct.split('\n')[0].trim();
  return looksLikePlaceholder(firstLine) ? '' : firstLine;
}

/**
 * Elements worth clicking to open a widget, best first.
 *
 * Very often the element carrying aria-haspopup is a wrapper whose real
 * clickable is a nested toggle (.select2-selection, .tpl-trigger, a caret
 * icon…). Clicking only the wrapper silently does nothing, so the caller
 * tries each candidate until a popup actually appears.
 */
function clickCandidates(trigger) {
  if (!trigger) return [];
  const out = [trigger];
  let inner = null;
  try {
    inner = trigger.querySelector(
      '.tpl-trigger, .select2-selection, .chosen-single, .MuiSelect-select, .MuiSelect-icon, ' +
      '.select2-selection__arrow, .dropdown-toggle, [class*="toggle" i], [class*="arrow" i], ' +
      '[class*="caret" i], [class*="chevron" i], [class*="indicator" i], [class*="icon" i], ' +
      'button, [role="button"]'
    );
  } catch (e) { inner = null; }
  if (inner && inner !== trigger) out.push(inner);
  return out;
}

/** Open a dropdown. Returns true when something was clicked/keyed. */
function openDropdown(trigger) {
  if (!trigger) return false;
  if (trigger.tagName === 'INPUT') {
    // select2 / datepicker inputs: a synthetic click opens the popup.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    trigger.focus?.();
    return true;
  }
  // Already open — leave it alone.
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  try {
    trigger.scrollIntoView({ block: 'nearest' });
  } catch (e) { /* ignore */ }
  trigger.focus?.();
  trigger.click();
  return true;
}

/**
 * Open a dropdown and wait for its popup to appear.
 *
 * On Google Forms the option list is rendered at body level, detached from the
 * trigger, so "did it open?" is answered by diffing the visible popups rather
 * than by looking inside the trigger.
 *
 * @returns the popup element, or null if nothing opened.
 */
async function openDropdownAndWait(trigger, { settleMs = 120, timeoutMs = 1200 } = {}) {
  const before = snapshotVisiblePopups();
  for (const candidate of clickCandidates(trigger)) {
    openDropdown(candidate);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = snapshotVisiblePopups().filter(p => !before.includes(p));
      if (fresh.length) return pickOpenedPopup(trigger, before, null);
      await new Promise(r => setTimeout(r, settleMs));
    }
    // Nothing opened for this candidate — try the nested toggle next.
  }
  return null;
}

/** Close a dropdown without leaving stray popups behind. */
function closeDropdown(trigger) {
  if (!trigger) return;
  if (trigger.tagName === 'INPUT') {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    trigger.blur?.();
    return;
  }
  if (trigger.getAttribute('aria-expanded') === 'true') {
    try { trigger.click(); } catch (e) { /* ignore */ }
  }
  trigger.blur?.();
}

function popupIsVisible(popup) {
  if (!popup) return false;
  if (!isElementVisible(popup)) return false;
  // A dropdown wrapper that is hidden but whose inner list shows still counts
  // as visible; check the inner list too.
  const inner = popup.querySelector(POPUP_SELECTORS.join(','));
  if (inner && inner !== popup && isElementVisible(inner)) return true;
  return true;
}

/**
 * Snapshot every visible popup on the page, so that after we open a widget we
 * can tell which popup is *ours*. This is the fix for the old bug where a
 * Google Forms listbox would match options belonging to a different question.
 */
function snapshotVisiblePopups() {
  return deepQueryAll(document, POPUP_SELECTORS.join(',')).filter(popupIsVisible);
}

/**
 * Given the popups that existed before, find the one that just appeared.
 * Prefers, in order: an explicitly referenced container, a new popup that
 * contains a matching option, then any new popup.
 */
function pickOpenedPopup(trigger, before, desiredText) {
  const now = snapshotVisiblePopups();
  const beforeSet = new Set(before);
  const fresh = now.filter(p => !beforeSet.has(p));

  // 1. Explicit aria reference wins.
  const owned = trigger.getAttribute?.('aria-owns') || trigger.getAttribute?.('aria-controls');
  if (owned) {
    const target = document.getElementById(owned);
    if (target && now.includes(target)) return target;
    const inner = target && target.querySelector(POPUP_SELECTORS.join(','));
    if (inner && now.includes(inner)) return inner;
  }

  // 2. A fresh popup that actually contains a matching option.
  if (desiredText) {
    const needle = String(desiredText).trim().toLowerCase();
    const withMatch = fresh.find(p => popupHasOptionText(p, needle));
    if (withMatch) return withMatch;
  }

  // 3. Any fresh popup.
  if (fresh.length) return fresh[fresh.length - 1];

  // 4. Nothing new: the popup may have been reused. Prefer a visible popup
  //    that is not an ancestor/descendant of the trigger.
  const unrelated = now.filter(p => !p.contains(trigger) && !trigger.contains?.(p));
  return unrelated[unrelated.length - 1] || null;
}

function popupHasOptionText(popup, needle) {
  if (!popup || !needle) return false;
  const opts = readPopupOptions(popup);
  return opts.some(o => o.text.toLowerCase().trim() === needle);
}

/** Read every option element inside a popup, in document order. */
function readPopupOptions(popup) {
  if (!popup) return [];
  const root = popup.matches?.(OPTION_SELECTORS.join(',')) ? popup.parentElement || popup : popup;
  let nodes = [];
  for (const sel of OPTION_SELECTORS) {
    try {
      const found = Array.from(root.querySelectorAll(sel));
      if (found.length) { nodes = found; break; }
    } catch (e) { /* ignore */ }
  }
  if (!nodes.length) {
    try { nodes = Array.from(popup.querySelectorAll('*')).filter(el => isElementVisible(el) && el.children.length === 0 && el.textContent.trim()); } catch (e) { nodes = []; }
  }
  const seen = new Set();
  const out = [];
  for (const el of nodes) {
    if (seen.has(el)) continue;
    // Skip container elements that merely wrap other options.
    if (el.querySelector(OPTION_SELECTORS.join(','))) continue;
    seen.add(el);
    const text = el.textContent.trim();
    if (!text) continue;
    out.push({
      el,
      text,
      value: el.getAttribute('data-value') || el.getAttribute('data-date') || el.getAttribute('value') || el.id || text,
      disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      selected: el.getAttribute('aria-selected') === 'true' || el.hasAttribute('selected')
    });
  }
  return out;
}

/** Type into a widget that accepts text, then commit with Enter. */
function typeIntoWidget(trigger, text) {
  if (!trigger) return false;
  let input = null;
  if (trigger.tagName === 'INPUT' || trigger.tagName === 'TEXTAREA') input = trigger;
  else {
    try { input = trigger.querySelector('input[type="text"], input[type="search"], input:not([type])'); } catch (e) { input = null; }
  }
  if (!input) return false;
  if (input.readOnly) return false;
  try {
    input.focus();
  } catch (e) { /* ignore */ }
  setNativeInputValue(input, '');
  setNativeInputValue(input, String(text));
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  return true;
}

/**
 * Keyboard route: open, arrow down until the active option text matches, enter.
 * Works for MS Forms and most ARIA comboboxes with no DOM assumptions.
 */
function keyboardSelect(trigger, targetText) {
  if (!trigger) return false;
  const needle = String(targetText || '').trim().toLowerCase();
  if (!needle) return false;
  try { trigger.focus(); } catch (e) { /* ignore */ }
  const key = (k, code) => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: code || k, bubbles: true }));
    trigger.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: code || k, bubbles: true }));
  };
  key('ArrowDown', 'ArrowDown');
  for (let i = 0; i < 40; i++) {
    const active = document.querySelector('[role="option"][aria-selected="true"], [data-active="true"], .active, .highlighted, .is-active');
    const text = active ? active.textContent.trim().toLowerCase() : '';
    if (text && (text === needle || text.includes(needle) || needle.includes(text))) {
      key('Enter', 'Enter');
      return true;
    }
    key('ArrowDown', 'ArrowDown');
  }
  return false;
}

// ═══════════════════════════════════════
// NATIVE VALUE SETTING
// React (and Vue, and Svelte) install a value setter on the element instance,
// so assigning el.value updates the DOM but never notifies their state. Calling
// the prototype setter goes around that.
// ═══════════════════════════════════════

function setNativeInputValue(el, value) {
  if (!el) return false;
  try {
    let proto = Object.getPrototypeOf(el);
    let desc = null;
    while (proto && !desc) {
      desc = Object.getOwnPropertyDescriptor(proto, 'value');
      proto = Object.getPrototypeOf(proto);
    }
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  } catch (e) {
    try { el.value = value; } catch (e2) { return false; }
  }
  const protoEvents = [new Event('input', { bubbles: true }), new Event('change', { bubbles: true })];
  for (const ev of protoEvents) {
    try { el.dispatchEvent(ev); } catch (e) { /* ignore */ }
  }
  return true;
}

function forceChecked(input, checked) {
  if (!input || input.checked === checked) return false;
  // A real click is the only reliable way to satisfy every framework's handler.
  input.click();
  if (input.checked !== checked) {
    // Some widgets block synthetic clicks; force the DOM state and tell listeners.
    input.checked = checked;
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch (e) { /* ignore */ }
  }
  return true;
}

function writeContentEditable(el, text) {
  if (!el) return false;
  try {
    el.focus();
    // execCommand keeps rich-text editors (Quill, Lexical, Slate, ProseMirror)
    // internally consistent. textContent alone corrupts their model.
    const ok = typeof document.execCommand === 'function' && document.execCommand('selectAll', false, null) && document.execCommand('insertText', false, String(text));
    if (!ok) el.textContent = String(text);
  } catch (e) {
    try { el.textContent = String(text); } catch (e2) { return false; }
  }
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) { /* ignore */ }
  return (el.textContent || '').trim() === String(text).trim();
}

function blurToCommit(el) {
  if (!el) return;
  try {
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.blur();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) { /* ignore */ }
}

// ═══════════════════════════════════════
// CLICK SIMULATION
// Widgets routinely listen for pointer/mouse sequences rather than click.
// ═══════════════════════════════════════

function userClick(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + Math.min(rect.width / 2, 12),
    clientY: rect.top + Math.min(rect.height / 2, 12),
    button: 0
  };
  try { el.dispatchEvent(new PointerEvent('pointerdown', init)); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mousedown', init)); } catch (e) { /* ignore */ }
  try { el.focus?.(); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch (e) { /* ignore */ }
  try { el.dispatchEvent(new MouseEvent('mouseup', init)); } catch (e) { /* ignore */ }
  try { el.click(); } catch (e) { return false; }
  return true;
}
