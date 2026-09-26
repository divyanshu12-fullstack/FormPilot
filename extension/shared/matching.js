// ── FormPilot Matching Logic ──
// Pure data logic: label normalization, and turning "the value we hold" into
// "the option the user should actually get". No DOM access, so it can be
// unit-tested on its own. Loaded after constants.js.

// ── Relaxed normalization: single helper shared by match + corrections ──
// Lowercases and strips punctuation that breaks token-boundary checks
// ("First Name:", "Email (Work)", "City/Town", "phone-number" → plain words).
function normalizeLabel(raw) {
  let s = (raw || '').toLowerCase();
  s = s.replace(/\xa0/g, ' ');
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
// requires section context too (see matchField in content_script.js).
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

/** Split a stored list value into trimmed, non-empty entries. */
function toList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
      } catch (e) { /* not JSON, fall through */ }
    }
    return trimmed.split(/[,;\n|]/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function normalizeOptionText(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Choose the option that best expresses a stored value.
 *
 * Order: exact → boolean → numeric range → ordinal → abbreviation → includes.
 * Refuses "Other" / "None of the above" rather than guessing, because picking
 * those without text to put in the follow-up box is worse than not answering.
 *
 * @returns {{option: object|null, reason: string}}
 *   reason is '' on success, else 'no-value' | 'no-option' | 'deferred'.
 */
function resolveOption(options, targetValue, fieldType) {
  const usable = (options || []).filter(o => o && !o.disabled);
  const target = String(targetValue === null || targetValue === undefined ? '' : targetValue).trim();
  if (!target) return { option: null, reason: 'no-value' };
  if (!usable.length) return { option: null, reason: 'no-option' };

  const needle = normalizeOptionText(target);

  // 1. Exact text or value
  let match = usable.find(o => normalizeOptionText(o.text) === needle || normalizeOptionText(o.value) === needle);
  if (match) return { option: match, reason: '' };

  // 2. Boolean semantics — profile says true/false, option says "Yes, I am authorized"
  const targetBool = coerceBooleanValue(target);
  if (targetBool !== null) {
    match = usable.find(o => {
      const b = parseBooleanOption(o.text) ?? parseBooleanOption(o.value);
      return b !== null && b === targetBool;
    });
    if (match) return { option: match, reason: '' };
  }
  // Options are boolean-ish but the stored value is prose ("Authorized to work")
  if (targetBool === null) {
    const anyBoolOption = usable.some(o => parseBooleanOption(o.text) !== null);
    if (anyBoolOption && /\b(authorized|authorised|eligible|yes|able|willing|available)\b/i.test(target)) {
      match = usable.find(o => parseBooleanOption(o.text) === true);
      if (match) return { option: match, reason: '' };
    }
  }

  // 3. Numeric range — profile 2 vs option "2-3 years"
  const targetNum = coerceNumericValue(target);
  if (targetNum !== null) {
    const ranged = usable
      .map(o => ({ o, r: parseRangeFromText(o.text) || parseRangeFromText(o.value) }))
      .filter(x => x.r);
    if (ranged.length) {
      // Prefer the tightest range that contains the value.
      const hits = ranged
        .filter(x => targetNum >= x.r.min && targetNum <= x.r.max)
        .sort((a, b) => (a.r.max - a.r.min) - (b.r.max - b.r.min));
      if (hits.length) return { option: hits[0].o, reason: '' };
      // Otherwise fall back to the nearest range, but only for off-by-one
      // rounding (2.0 years vs a "0-1 / 2-3" split should never pick "0-1").
      let best = null, bestDist = Infinity;
      for (const x of ranged) {
        const dist = targetNum < x.r.min ? x.r.min - targetNum
          : targetNum > x.r.max ? targetNum - x.r.max : 0;
        if (dist < bestDist) { bestDist = dist; best = x; }
      }
      if (best && bestDist <= 1) return { option: best.o, reason: '' };
    }
  }

  // 4. Ordinal
  const targetOrd = parseOrdinal(target);
  if (targetOrd !== null) {
    match = usable.find(o => parseOrdinal(o.text) === targetOrd || parseOrdinal(o.value) === targetOrd);
    if (match) return { option: match, reason: '' };
  }

  // 5. Abbreviation map
  const abbrMap = fieldType ? ABBREVIATION_MAPS[fieldType] || ABBREVIATION_MAPS[String(fieldType).toLowerCase()] : null;
  if (abbrMap) {
    // Longer / more specific variants first, so "Female" is tried before "Male".
    const entries = Object.entries(abbrMap).sort((a, b) => {
      const aLen = Math.max(a[0].length, ...a[1].map(v => v.length));
      const bLen = Math.max(b[0].length, ...b[1].map(v => v.length));
      return bLen - aLen;
    });
    for (const [abbr, variants] of entries) {
      const abbrN = normalizeOptionText(abbr);
      const variantNs = variants.map(normalizeOptionText);
      if (abbrN === needle || variantNs.includes(needle)) {
        let hit = usable.find(o => normalizeOptionText(o.text) === abbrN || normalizeOptionText(o.value) === abbrN);
        if (hit) return { option: hit, reason: '' };
        for (const v of variantNs) {
          hit = usable.find(o => normalizeOptionText(o.text) === v || normalizeOptionText(o.value) === v);
          if (hit) return { option: hit, reason: '' };
        }
      }
    }
  }

  // 6. Includes — require the shorter side to be ≥3 chars, so "M" cannot
  //    match "Female" and "US" cannot match "Russia".
  match = usable.find(o => {
    const t = normalizeOptionText(o.text);
    if (!t || t.length < 3 || needle.length < 3) return false;
    if ((needle === 'male' && t === 'female') || (needle === 'female' && t === 'male')) return false;
    return t.includes(needle) || needle.includes(t);
  });
  if (match) return { option: match, reason: '' };

  // 7. Refuse "Other" / "None of the above" — we have no text for the follow-up.
  const deferred = usable.find(o => isDeferredOption(o.text));
  if (deferred) return { option: null, reason: 'deferred' };

  return { option: null, reason: 'no-option' };
}

/**
 * For list-valued profile fields (skills, languages) return every option that
 * matches any entry. Never invents: unmatched entries are simply left alone.
 */
function resolveMultipleOptions(options, listValue) {
  const entries = toList(listValue);
  if (!entries.length) return { options: [], unmatched: [] };
  const hits = [];
  const unmatched = [];
  const taken = new Set();
  for (const entry of entries) {
    const { option } = resolveOption(options, entry, null);
    if (option && !taken.has(option)) { hits.push(option); taken.add(option); }
    else if (!option) unmatched.push(entry);
  }
  return { options: hits, unmatched };
}

/** Back-compat wrapper for callers that only need the option itself. */
function fuzzyMatchOption(options, targetValue, fieldType) {
  return resolveOption(options, targetValue, fieldType).option;
}
