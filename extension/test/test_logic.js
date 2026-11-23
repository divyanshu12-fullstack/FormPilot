// ── FormPilot Logic Tests ──
// Covers the pure data logic that used to be untestable inside the content
// script: option resolution, range/boolean/ordinal parsing, date
// normalization, consent detection, and label utilities.
//
// Runs two ways:
//   • Browser — open extension/test/test_logic.html
//   • Node    — node extension/test/run_logic_tests.js
// No framework, no dependencies.

(function () {
  const results = [];
  let currentGroup = '';

  function group(name) { currentGroup = name; }

  function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ group: currentGroup, name, pass, actual, expected });
    return pass;
  }

  function checkTrue(name, actual) { return check(name, !!actual, true); }

  const opts = (...texts) => texts.map(t => ({ value: t, text: t, disabled: false }));

  // ══════════════ Label normalization ══════════════
  group('label utils');

  check('strips punctuation', normalizeLabel('First Name:'), 'first name');
  check('handles Email (Work)', normalizeLabel('Email (Work)'), 'email work');
  check('collapses separators', normalizeLabel('City/Town'), 'city town');
  check('token match, not substring', labelHasToken(normalizeLabel('Mother name'), 'other'), false);
  check('token match on whole word', labelHasToken(normalizeLabel('Other address'), 'other'), true);
  check('toList splits commas', toList('JS, React , Python'), ['JS', 'React', 'Python']);
  check('toList parses JSON', toList('["a","b"]'), ['a', 'b']);
  check('toList empty', toList(''), []);

  // ══════════════ Exact + deferred options ══════════════
  group('option: exact');

  check('exact text', resolveOption(opts('Male', 'Female'), 'Female', 'gender').option?.text, 'Female');
  check('empty value is no-value', resolveOption(opts('A', 'B'), '', 'gender').reason, 'no-value');
  check('no options is no-option', resolveOption([], 'Female', 'gender').reason, 'no-option');
  check('unmatched is no-option', resolveOption(opts('Male', 'Female'), 'Zebra', 'gender').reason, 'no-option');
  check(
    'refuses "Other" instead of guessing',
    resolveOption(opts('Male', 'Female', 'Other'), 'Nonexistentvalue', 'gender').reason,
    'deferred'
  );
  check('disabled options are never selected', resolveOption(
    [{ value: 'A', text: 'Alpha', disabled: true }, { value: 'B', text: 'Beta', disabled: false }],
    'Alpha', null
  ).reason, 'no-option');
  check('a disabled exact match is skipped for an enabled one', resolveOption(
    [{ value: 'X', text: 'Bhopal', disabled: true }, { value: 'Y', text: 'Bhopal', disabled: false }],
    'Bhopal', null
  ).option?.value, 'Y');

  // ══════════════ Boolean semantics ══════════════
  group('option: boolean');

  check('Yes/No from "Yes"', resolveOption(opts('Yes', 'No'), 'Yes', 'work_authorization').option?.text, 'Yes');
  check('Yes/No from "No"', resolveOption(opts('Yes', 'No'), 'No', 'work_authorization').option?.text, 'No');
  check('boolean value maps to explicit Yes/No options', resolveOption(opts('Yes', 'No'), 'true', FIELD_TYPES.WORK_AUTHORIZATION).option?.text, 'Yes');
  check('inferred affirmative prose is declined', resolveOption(opts('Yes', 'No'), 'Authorized', FIELD_TYPES.WORK_AUTHORIZATION).reason, 'no-option');
  check('negative phrase never matches positive option', resolveOption(opts('Yes', 'No'), 'not willing', FIELD_TYPES.RELOCATION_OK).reason, 'no-option');
  check(
    'long option phrasing',
    resolveOption(opts('Yes, I am authorized to work', 'No, I will require sponsorship'), 'Yes', 'work_authorization').option?.text,
    'Yes, I am authorized to work'
  );
  check('coerceBooleanValue true', coerceBooleanValue('true'), true);
  check('coerceBooleanValue false', coerceBooleanValue('no'), false);
  check('coerceBooleanValue unknown', coerceBooleanValue('Bhopal'), null);

  // ══════════════ Numeric ranges ══════════════
  group('option: ranges');

  check('2 years -> 2-3', resolveOption(opts('0-1 years', '2-3 years', '4+ years'), '2', 'experience_years').option?.text, '2-3 years');
  check('0 years -> 0-1', resolveOption(opts('0-1 years', '2-3 years', '4+ years'), '0', 'experience_years').option?.text, '0-1 years');
  check('5 years -> 4+', resolveOption(opts('0-1 years', '2-3 years', '4+ years'), '5', 'experience_years').option?.text, '4+ years');
  check('"to" range', resolveOption(opts('Fresher', '1 to 3 years', '4+ years'), '2', 'experience_years').option?.text, '1 to 3 years');
  check('"less than" range', resolveOption(opts('Less than 1 year', '1-3 years', '4+ years'), '0', 'experience_years').option?.text, 'Less than 1 year');
  check('"more than" range', resolveOption(opts('0-2 years', 'More than 5'), '7', 'experience_years').option?.text, 'More than 5');
  check('overlapping ranges are ambiguous', resolveOption(opts('0-5 years', '2-3 years'), '2.5', FIELD_TYPES.EXPERIENCE_YEARS).reason, 'ambiguous');
  // With a real gap between the offered ranges there is no safe answer.
  check('declines when the value falls in a gap', resolveOption(opts('0-1 years', '5+ years'), '3', 'experience_years').reason, 'no-option');
  check('accepts an off-by-one at the boundary', resolveOption(opts('0-1 years', '2-3 years'), '1', 'experience_years').option?.text, '0-1 years');
  check('months map only into compatible year ranges', resolveOption(opts('0-1 years', '2-3 years', '4+ years'), 24, FIELD_TYPES.TOTAL_EXPERIENCE_MONTHS).option?.text, '2-3 years');
  check('incompatible duration units are declined', resolveOption(opts('0-1 days', '2-3 days', '4+ days'), 24, FIELD_TYPES.TOTAL_EXPERIENCE_MONTHS).reason, 'no-option');
  check('parseRangeFromText 4+', parseRangeFromText('4+'), {
    min: 4, max: Infinity, minInclusive: true, maxInclusive: true,
    isOpenTop: true, unit: null
  });
  check('parseRangeFromText 12th', parseRangeFromText('12th'), {
    min: 12, max: 12, minInclusive: true, maxInclusive: true,
    isOpenTop: false, exact: true, unit: 'ordinal'
  });
  check('parseRangeFromText garbage', parseRangeFromText('United States'), null);

  // ══════════════ Ordinals ══════════════
  group('option: ordinals');

  check('explicit second ordinal', resolveOption(opts('First', 'Second', 'Third'), '2nd', null).option?.text, 'Second');
  check('bare cardinal is not an ordinal guess', resolveOption(opts('First', 'Second', 'Third'), '2', null).reason, 'no-option');
  check('explicit 3rd suffix', resolveOption(opts('1st', '2nd', '3rd'), '3rd', null).option?.text, '3rd');

  // ══════════════ Abbreviation maps ══════════════
  group('option: abbreviations');

  check('B.Tech -> BTech', resolveOption(opts('BTech', 'MTech', 'MBA'), 'B.Tech', 'degree').option?.text, 'BTech');
  check('country code', resolveOption(opts('India', 'United States', 'Germany'), 'US', 'country').option?.text, 'United States');
  check('F -> Female not Male', resolveOption(opts('Male', 'Female'), 'F', 'gender').option?.text, 'Female');
  check('M -> Male', resolveOption(opts('Male', 'Female'), 'M', 'gender').option?.text, 'Male');
  check('notice period 30 days', resolveOption(opts('Immediate', '30 days', '60 days'), '30', FIELD_TYPES.NOTICE_PERIOD).option?.text, '30 days');
  check('degree 12th', resolveOption(opts('10th', '12th', 'Graduated'), '12th', 'degree').option?.text, '12th');

  // ══════════════ Substring guard ══════════════
  group('option: substring safety');

  check('male does not match Female', resolveOption(opts('Male', 'Female'), 'male', 'gender').option?.text, 'Male');
  check('short token cannot match', resolveOption(opts('Russia', 'United States'), 'US', 'country').option?.text, 'United States');
  check('city substring is declined', resolveOption(opts('Bhopal, Madhya Pradesh', 'Indore'), 'Bhopal', null).reason, 'no-option');
  check('duplicate exact labels are ambiguous', resolveOption(opts('Bhopal', 'Bhopal'), 'Bhopal', null).reason, 'ambiguous');

  // ══════════════ Multi-value ══════════════
  group('option: multi-select');

  const skillOpts = opts('HTML', 'CSS', 'JavaScript', 'React', 'Node.js', 'Python');
  const multi = resolveMultipleOptions(skillOpts, 'JavaScript, React, Kotlin');
  check('matches every listed skill it can', multi.options.map(o => o.text), ['JavaScript', 'React']);
  check('reports unmatched entries', multi.unmatched, ['Kotlin']);
  check('never invents a skill', resolveMultipleOptions(skillOpts, 'Kotlin, Rust').options.length, 0);
  check('duplicate option labels are declined', resolveMultipleOptions(opts('JS', 'JS'), 'JS').options.length, 0);
  check('ambiguous list option is reported unmatched', resolveMultipleOptions(opts('JS', 'JS'), 'JS').unmatched, ['JS']);

  // ══════════════ Consent detection ══════════════
  group('consent detection');

  checkTrue('I agree to terms', isConsentLabel('I agree to the terms and conditions'));
  checkTrue('newsletter opt-in', isConsentLabel('Send me marketing emails'));
  checkTrue('declaration', isConsentLabel('I hereby declare the information provided is true'));
  checkTrue('privacy policy', isConsentLabel('I have read the privacy policy'));
  check('plain data label is not consent', isConsentLabel('Gender'), false);
  check('skills label is not consent', isConsentLabel('Which languages do you know?'), false);

  // ══════════════ Deferred options ══════════════
  group('deferred options');

  checkTrue('Other', isDeferredOption('Other'));
  checkTrue('None of the above', isDeferredOption('None of the above'));
  checkTrue('Prefer not to say', isDeferredOption('Prefer not to say'));
  check('a real answer is not deferred', isDeferredOption('Bhopal'), false);

  // ══════════════ Date parsing ══════════════
  group('date: parsing');

  check('ISO', parseDateParts('2000-01-15'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('d/m/y', parseDateParts('15/01/2000'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('m/d/y', parseDateParts('01/15/2000'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('dashes', parseDateParts('15-01-2000'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('month name', parseDateParts('Jan 2000'), { y: 2000, m: 1, d: 1, hh: 0, mm: 0 });
  check('day month-name year', parseDateParts('15 January 2000'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('month name day year', parseDateParts('January 15, 2000'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('compact 8-digit', parseDateParts('20000115'), { y: 2000, m: 1, d: 15, hh: 0, mm: 0 });
  check('year only', parseDateParts('2024'), { y: 2024, m: 1, d: 1, hh: 0, mm: 0 });
  check('nonsense', parseDateParts('not a date'), null);
  check('empty', parseDateParts(''), null);

  // ══════════════ Date formatting per control kind ══════════════
  group('date: formatting');

  check('date control', normalizeDateValue('15/01/2000', FIELD_KIND.DATE, 'dmy'), '2000-01-15');
  check('month control', normalizeDateValue('15/01/2000', FIELD_KIND.MONTH, 'dmy'), '2000-01');
  check('datetime requires an explicit time', normalizeDateValue('2000-01-15', FIELD_KIND.DATETIME, 'dmy'), null);
  check('datetime control', normalizeDateValue('2000-01-15T09:30', FIELD_KIND.DATETIME, 'dmy'), '2000-01-15T09:30');
  check('time control', normalizeDateValue('09:30', FIELD_KIND.TIME, 'dmy'), '09:30');
  check('12-hour time', normalizeDateValue('2:30 PM', FIELD_KIND.TIME, 'dmy'), '14:30');
  check('unparseable returns null', normalizeDateValue('sometime in 2000', FIELD_KIND.DATE, 'dmy'), null);
  check('date parts, day-first', normalizeDateValue('15/01/2000', FIELD_KIND.DATE_PARTS, 'dmy'), { dd: '15', mm: '01', yyyy: '2000' });
  check('date parts, month-first', normalizeDateValue('01/15/2000', FIELD_KIND.DATE_PARTS, 'mdy'), { mm: '01', dd: '15', yyyy: '2000' });

  // Ambiguous numeric dates require an explicit format hint.
  check('ambiguous defaults month-first', parseDateParts('01/02/2000').ambiguous, true);
  check('ambiguous fill abstains without format hint', normalizeDateValue('01/02/2000', FIELD_KIND.DATE, null), null);
  check('ambiguous fill uses month-first hint', normalizeDateValue('01/02/2000', FIELD_KIND.DATE, 'mdy'), '2000-01-02');
  check('ambiguous fill uses day-first hint', normalizeDateValue('01/02/2000', FIELD_KIND.DATE, 'dmy'), '2000-02-01');
  check('impossible calendar date is rejected', normalizeDateValue('2000-02-31', FIELD_KIND.DATE, 'mdy'), null);
  check('day>12 forces d/m/y', parseDateParts('25/01/2000'), { y: 2000, m: 1, d: 25, hh: 0, mm: 0 });
  check('month>12 forces m/d/y', parseDateParts('01/25/2000'), { y: 2000, m: 1, d: 25, hh: 0, mm: 0 });

  // ══════════════ Field kinds ══════════════
  group('field kinds');

  check('SKIP types are choice kinds', CHOICE_KINDS.has(FIELD_KIND.RADIO), true);
  check('multi kinds', MULTI_KINDS.has(FIELD_KIND.MULTI_SELECT), true);
  check('date kinds', DATE_KINDS.has(FIELD_KIND.DATE_PARTS), true);
  check('text is not a choice kind', CHOICE_KINDS.has(FIELD_KIND.TEXT), false);
  checkTrue('profile has cgpa', FIELD_TYPES.CGPA === 'cgpa');
  checkTrue('profile has dob', FIELD_TYPES.DOB === 'dob');
  checkTrue('profile has degree + branch', FIELD_TYPES.DEGREE === 'degree' && FIELD_TYPES.BRANCH === 'branch');
  checkTrue('skills is a list type', LIST_FIELD_TYPES.has(FIELD_TYPES.SKILLS));

  // ── Report ──
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { results, passed, failed, total: results.length };
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__formpilotLogicResults = { results, passed, failed, total: results.length };
  }

  if (typeof console !== 'undefined' && typeof window === 'undefined') {
    for (const f of failed) {
      console.log(`FAIL  [${f.group}] ${f.name}`);
      console.log(`      expected: ${JSON.stringify(f.expected)}`);
      console.log(`      actual:   ${JSON.stringify(f.actual)}`);
    }
    console.log(`\n${passed}/${results.length} logic tests passed`);
    if (failed.length && typeof process !== 'undefined') process.exitCode = 1;
  }
})();
