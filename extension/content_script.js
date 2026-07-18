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

const SKIP_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'file']);

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

    // 5. Date inputs
    for (const el of document.querySelectorAll('input[type="date"]')) {
      if (!isVisible(el) || seen.has(el)) continue;
      seen.add(el);
      fields.push(buildFieldObj(el, resolveGFormsLabel(el), false, ''));
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

function matchField(field, profile) {
  const section = field.sectionContext.toLowerCase();
  for (const skip of SKIP_SECTIONS) {
    if (section.includes(skip)) return null;
  }

  // 1. Check signatures
  for (const [sig, type] of Object.entries(FIELD_SIGNATURES)) {
    if (field.name === sig || field.id === sig) {
      return { type, value: getProfileValue(type, profile) };
    }
  }

  // 2. Keyword mapping
  let label = (field.labelText || field.placeholder || field.ariaLabel || '').toLowerCase();
  // Normalize non-breaking spaces and strip asterisks
  label = label.replace(/\xa0/g, ' ').replace(/\*/g, '').trim();

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
        const rEl = el.querySelector(`[data-value="${CSS.escape(matched.value)}"], [value="${CSS.escape(matched.value)}"], [role="radio"]:not([data-value]), [role="checkbox"]:not([data-value])`);
        // If no data-value, we need to find by text content again
        if (rEl) {
           rEl.click();
           return true;
        } else {
           // fallback click search
           const allChildren = el.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]');
           for(let child of allChildren) {
             const lbl = resolveLabel(child);
             if (lbl === matched.text) { child.click(); return true; }
           }
        }
      }
    }
  }
  return false;
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
    let needsReviewCount = 0;

    (async () => {
      for (const field of fields) {
        const match = matchField(field, message.profile);
        if (match) {
           const success = await fillField(field, match);
           if (success) matchedCount++;
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

  return false;
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

(function init() {
  currentPlatform = detectPlatform();
  console.log(`[FormPilot] Platform: ${currentPlatform}`);

  collectFields();
  console.log(`[FormPilot] Initial scan: ${cachedFields.length} fields`);
  cachedFields.forEach((f, i) => {
    console.log(`[FormPilot]  ${i + 1}. "${f.labelText}" type=${f.type} id="${f.id}" name="${f.name}" section="${f.sectionContext}" options=${f.options.length}`);
  });

  domObserver.observe(document.body, { childList: true, subtree: true });
  checkForIframes();
})();
