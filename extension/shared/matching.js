// Conservative, DOM-independent label and option matching.

function normalizeLabel(raw) {
  let value = String(raw || '').toLowerCase().replace(/\xa0/g, ' ');
  value = value.replace(/[*_:;,()\/\\\-_.?!"'&|+@#%[\]{}<>]/g, ' ');
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSig(raw) {
  return normalizeLabel(raw).replace(/\s+/g, '');
}

function labelHasToken(label, token) {
  if (!label || !token) return false;
  if (label === token) return true;
  return label.includes(` ${token} `) || label.startsWith(`${token} `) || label.endsWith(` ${token}`);
}

const HARD_NEGATIVE_LABEL_KEYWORDS = [
  'father', 'mother', 'spouse', 'husband', 'wife',
  'guardian', 'nominee', 'emergency', 'next of kin'
];

const SOFT_NEGATIVE_LABEL_KEYWORDS = [
  'reference', 'referral', 'supervisor', 'manager',
  'secondary', 'alternate', 'other', 'previous', 'former',
  'parent', 'family'
];

const NEGATIVE_LABEL_KEYWORDS = [
  ...HARD_NEGATIVE_LABEL_KEYWORDS,
  ...SOFT_NEGATIVE_LABEL_KEYWORDS
];

function sectionHasToken(section, token) {
  return labelHasToken(section, token);
}

function toList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(item => String(item).trim()).filter(Boolean);
    } catch (error) { /* parse as delimited text below */ }
  }
  return trimmed.split(/[,;\n|]/).map(item => item.trim()).filter(Boolean);
}

function normalizeOptionText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function uniqueOptionMatch(options, predicate) {
  const matches = options.filter(predicate);
  if (matches.length === 1) return { option: matches[0], reason: '' };
  return { option: null, reason: matches.length > 1 ? 'ambiguous' : 'no-option' };
}

function numericUnitFromText(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(?:years?|yrs?|annum)\b/.test(value)) return 'years';
  if (/\b(?:months?|mos?)\b/.test(value)) return 'months';
  if (/\bdays?\b/.test(value)) return 'days';
  if (/\b(?:percent|percentage)\b|%/.test(value)) return 'percent';
  return null;
}

function numericUnitForField(fieldType) {
  switch (String(fieldType || '').toLowerCase()) {
    case FIELD_TYPES.EXPERIENCE_YEARS: return 'years';
    case FIELD_TYPES.TOTAL_EXPERIENCE_MONTHS: return 'months';
    case FIELD_TYPES.NOTICE_PERIOD: return 'days';
    case FIELD_TYPES.CGPA: return 'score';
    case FIELD_TYPES.TENTH_PERCENT:
    case FIELD_TYPES.TWELFTH_PERCENT: return 'percent';
    default: return null;
  }
}

function convertDuration(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  if (fromUnit === 'years' && toUnit === 'months') return value * 12;
  if (fromUnit === 'months' && toUnit === 'years') return value / 12;
  return null;
}

function rangeContains(range, value) {
  const aboveMin = range.minInclusive === false ? value > range.min : value >= range.min;
  const belowMax = range.maxInclusive === false ? value < range.max : value <= range.max;
  return aboveMin && belowMax;
}

function mapAlias(options, target, fieldType) {
  const aliasMap = fieldType
    ? ABBREVIATION_MAPS[fieldType] || ABBREVIATION_MAPS[String(fieldType).toLowerCase()]
    : null;
  if (!aliasMap) return { option: null, reason: 'no-option' };

  const needle = normalizeOptionText(target);
  const acceptedTexts = new Set();
  for (const [alias, variants] of Object.entries(aliasMap)) {
    const normalizedAlias = normalizeOptionText(alias);
    const normalizedVariants = variants.map(normalizeOptionText);
    if (needle !== normalizedAlias && !normalizedVariants.includes(needle)) continue;
    acceptedTexts.add(normalizedAlias);
    normalizedVariants.forEach(variant => acceptedTexts.add(variant));
  }

  if (!acceptedTexts.size) return { option: null, reason: 'no-option' };
  return uniqueOptionMatch(options, option =>
    acceptedTexts.has(normalizeOptionText(option.text))
    || acceptedTexts.has(normalizeOptionText(option.value)));
}

/**
 * Resolve a stored value to one option only when there is one clear match.
 * No substring or nearest-range fallback is used. Reasons are '', 'no-value',
 * 'no-option', 'deferred', and 'ambiguous'.
 */
function resolveOption(options, targetValue, fieldType) {
  const usable = (options || []).filter(option => option && !option.disabled);
  const target = String(targetValue === null || targetValue === undefined ? '' : targetValue).trim();
  if (!target) return { option: null, reason: 'no-value' };
  if (!usable.length) return { option: null, reason: 'no-option' };

  const needle = normalizeOptionText(target);

  // 1. Exact label/value. Duplicate exact choices require a user decision.
  const exact = uniqueOptionMatch(usable, option =>
    normalizeOptionText(option.text) === needle || normalizeOptionText(option.value) === needle);
  if (exact.option || exact.reason === 'ambiguous') return exact;

  // 2. Boolean choice semantics, restricted to boolean profile fields.
  const isBooleanField = BOOLEAN_FIELD_TYPES.has(fieldType) || typeof targetValue === 'boolean';
  const targetBool = isBooleanField ? coerceBooleanValue(target) : null;
  if (targetBool !== null) {
    const booleanMatch = uniqueOptionMatch(usable, option => {
      const parsed = parseBooleanOption(option.text) ?? parseBooleanOption(option.value);
      return parsed !== null && parsed === targetBool;
    });
    if (booleanMatch.option || booleanMatch.reason === 'ambiguous') return booleanMatch;
  }

  // 3. A numeric match must be within exactly one range of a compatible unit.
  const fieldUnit = numericUnitForField(fieldType);
  const targetNumber = coerceNumericValue(target);
  if (fieldUnit && targetNumber !== null) {
    const targetUnit = numericUnitFromText(target) || fieldUnit;
    const targetValueInFieldUnit = convertDuration(targetNumber, targetUnit, fieldUnit);
    if (targetValueInFieldUnit !== null || targetUnit === fieldUnit) {
      const normalizedTarget = targetValueInFieldUnit === null ? targetNumber : targetValueInFieldUnit;
      const ranges = usable.map(option => ({
        option,
        range: parseRangeFromText(option.text) || parseRangeFromText(option.value)
      })).filter(item => item.range);
      const hits = ranges.filter(({ range }) => {
        const optionUnit = range.unit || fieldUnit;
        let min = range.min;
        let max = range.max;
        if (optionUnit !== fieldUnit) {
          min = convertDuration(min, optionUnit, fieldUnit);
          max = max === Infinity ? Infinity : convertDuration(max, optionUnit, fieldUnit);
          if (min === null || max === null) return false;
        }
        return rangeContains({ ...range, min, max }, normalizedTarget);
      });
      if (hits.length === 1) return { option: hits[0].option, reason: '' };
      if (hits.length > 1) return { option: null, reason: 'ambiguous' };
    }
  }

  // 4. Explicit ordinal words/suffixes only. Bare numbers stay cardinal.
  const targetOrdinal = parseOrdinal(target);
  if (targetOrdinal !== null) {
    const ordinalMatch = uniqueOptionMatch(usable, option =>
      parseOrdinal(option.text) === targetOrdinal || parseOrdinal(option.value) === targetOrdinal);
    if (ordinalMatch.option || ordinalMatch.reason === 'ambiguous') return ordinalMatch;
  }

  // 5. A reviewed alias is safe only if it identifies one option.
  const aliasMatch = mapAlias(usable, target, fieldType);
  if (aliasMatch.option || aliasMatch.reason === 'ambiguous') return aliasMatch;

  if (usable.some(option => isDeferredOption(option.text))) {
    return { option: null, reason: 'deferred' };
  }
  return { option: null, reason: 'no-option' };
}

/** Match list values individually; unmatched entries remain for the user. */
function resolveMultipleOptions(options, listValue, fieldType = null) {
  const entries = toList(listValue);
  if (!entries.length) return { options: [], unmatched: [] };
  const hits = [];
  const unmatched = [];
  const taken = new Set();
  for (const entry of entries) {
    const result = resolveOption(options, entry, fieldType);
    if (result.option && !taken.has(result.option)) {
      hits.push(result.option);
      taken.add(result.option);
    } else if (!result.option) {
      unmatched.push(entry);
    }
  }
  return { options: hits, unmatched };
}

function fuzzyMatchOption(options, targetValue, fieldType) {
  return resolveOption(options, targetValue, fieldType).option;
}
