// ── FormPilot Constants ──
// Field types, keyword maps, option semantics, and value normalizers.
// Loaded before content_script.js and widgets.js in the manifest.

const FIELD_TYPES = {
  // Identity
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  FULL_NAME: 'full_name',
  EMAIL: 'email',
  PHONE: 'phone',
  DOB: 'dob',
  // Address
  ADDRESS_LINE1: 'address_line1',
  CITY: 'city',
  STATE: 'state',
  PINCODE: 'pincode',
  COUNTRY: 'country',
  PREFERRED_LOCATION: 'preferred_location',
  // Links
  LINKEDIN_URL: 'linkedin_url',
  GITHUB_URL: 'github_url',
  PORTFOLIO_URL: 'portfolio_url',
  // Work
  CURRENT_TITLE: 'current_title',
  CURRENT_COMPANY: 'current_company',
  EXPERIENCE_YEARS: 'experience_years',
  TOTAL_EXPERIENCE_MONTHS: 'total_experience_months',
  NOTICE_PERIOD: 'notice_period_days',
  WORK_AUTHORIZATION: 'work_authorization',
  RELOCATION_OK: 'relocation_ok',
  REMOTE_WORK_OK: 'remote_work_ok',
  MARITAL_STATUS: 'marital_status',
  BLOOD_GROUP: 'blood_group',
  // Education
  COLLEGE_NAME: 'college_name',
  DEGREE: 'degree',
  BRANCH: 'branch',
  GRADUATION_YEAR: 'graduation_year',
  CGPA: 'cgpa',
  TENTH_PERCENT: 'tenth_percent',
  TWELFTH_PERCENT: 'twelfth_percent',
  // Demographics
  GENDER: 'gender',
  VETERAN_STATUS: 'veteran_status',
  DISABILITY_STATUS: 'disability_status',
  // Collections
  SKILLS: 'skills',
  LANGUAGES: 'languages'
};

// ── Control kinds ──
// Every collected field carries exactly one. Drives both matching and filling.
const FIELD_KIND = {
  TEXT: 'text',
  TEXTAREA: 'textarea',
  EMAIL: 'email',
  TEL: 'tel',
  URL: 'url',
  NUMBER: 'number',
  SELECT: 'select',
  MULTI_SELECT: 'multi-select',
  RADIO: 'radio',
  CHECKBOX_SINGLE: 'checkbox-single',
  CHECKBOX_MULTI: 'checkbox-multi',
  DATE: 'date',
  DATETIME: 'datetime',
  MONTH: 'month',
  TIME: 'time',
  DATE_PARTS: 'date-parts',
  CUSTOM_DROPDOWN: 'custom-dropdown',
  RICH_TEXT: 'richtext',
  FILE: 'file',
  UNKNOWN: 'unknown'
};

// Kinds that hold one of a fixed set of options.
const CHOICE_KINDS = new Set([
  FIELD_KIND.SELECT,
  FIELD_KIND.MULTI_SELECT,
  FIELD_KIND.RADIO,
  FIELD_KIND.CHECKBOX_SINGLE,
  FIELD_KIND.CHECKBOX_MULTI,
  FIELD_KIND.CUSTOM_DROPDOWN
]);

// Kinds that can hold more than one value at a time.
const MULTI_KINDS = new Set([
  FIELD_KIND.MULTI_SELECT,
  FIELD_KIND.CHECKBOX_MULTI
]);

// Kinds whose value must be normalized before it can be set.
const DATE_KINDS = new Set([
  FIELD_KIND.DATE,
  FIELD_KIND.DATETIME,
  FIELD_KIND.MONTH,
  FIELD_KIND.TIME,
  FIELD_KIND.DATE_PARTS
]);

const NATIVE_DATE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'time', 'week']);

const FIELD_KEYWORDS = {
  [FIELD_TYPES.FIRST_NAME]: ['first name', 'given name', 'fname', 'forename'],
  [FIELD_TYPES.LAST_NAME]: ['last name', 'family name', 'surname', 'lname', 'sur name'],
  [FIELD_TYPES.FULL_NAME]: ['full name', 'your name', 'applicant name', 'candidate name', 'name', 'applicant full name'],
  [FIELD_TYPES.EMAIL]: ['email', 'e-mail', 'email address', 'email id', 'e mail', 'mail', 'contact email'],
  [FIELD_TYPES.PHONE]: ['phone', 'mobile', 'telephone', 'cell', 'tel', 'mob', 'phone number', 'contact number', 'contact'],
  [FIELD_TYPES.DOB]: ['date of birth', 'birth date', 'birthday', 'dob', 'born on'],
  [FIELD_TYPES.ADDRESS_LINE1]: ['address', 'street', 'street address', 'address line 1', 'line 1', 'address line 2', 'line 2', 'address 2', 'address line'],
  [FIELD_TYPES.CITY]: ['city', 'town', 'city town'],
  [FIELD_TYPES.STATE]: ['state', 'province', 'region', 'county', 'state province'],
  [FIELD_TYPES.PINCODE]: ['zip', 'postal', 'pincode', 'zip code', 'zipcode', 'pin code', 'pin', 'postal code'],
  [FIELD_TYPES.COUNTRY]: ['country', 'nation', 'nationality'],
  [FIELD_TYPES.PREFERRED_LOCATION]: ['preferred location', 'preferred city', 'location preference', 'work location', 'job location', 'preferred work location', 'location of interest', 'based in'],
  [FIELD_TYPES.LINKEDIN_URL]: ['linkedin', 'linked in', 'linkedin profile', 'linkedin url'],
  [FIELD_TYPES.GITHUB_URL]: ['github', 'git hub', 'github url'],
  [FIELD_TYPES.PORTFOLIO_URL]: ['portfolio', 'personal website', 'portfolio url', 'portfolio link', 'website', 'personal site'],
  [FIELD_TYPES.CURRENT_TITLE]: ['current title', 'job title', 'designation', 'role', 'position', 'title'],
  [FIELD_TYPES.CURRENT_COMPANY]: ['company', 'current company', 'employer', 'organisation', 'organization', 'company name', 'org name', 'org'],
  [FIELD_TYPES.EXPERIENCE_YEARS]: ['experience', 'years of experience', 'yoe', 'yrs', 'total experience', 'exp', 'work experience', 'how many years'],
  [FIELD_TYPES.TOTAL_EXPERIENCE_MONTHS]: ['experience in months', 'months of experience', 'total months'],
  [FIELD_TYPES.NOTICE_PERIOD]: ['notice period', 'joining time', 'joining date', 'time to join', 'when can you join', 'availability', 'available from'],
  [FIELD_TYPES.WORK_AUTHORIZATION]: ['authorization', 'authorized', 'visa', 'sponsorship', 'sponsor', 'right to work'],
  [FIELD_TYPES.RELOCATION_OK]: ['willing to relocate', 'open to relocation', 'relocate', 'relocation'],
  [FIELD_TYPES.REMOTE_WORK_OK]: ['remote work', 'work from home', 'wfh', 'remote job', 'work remotely', 'remote role'],
  [FIELD_TYPES.MARITAL_STATUS]: ['marital status', 'married', 'civil status'],
  [FIELD_TYPES.BLOOD_GROUP]: ['blood group', 'blood type'],
  [FIELD_TYPES.COLLEGE_NAME]: ['college', 'university', 'institution', 'institute', 'school name', 'alma mater', 'graduating from'],
  [FIELD_TYPES.DEGREE]: ['degree', 'qualification', 'education level', 'highest qualification', 'program', 'programme', 'course'],
  [FIELD_TYPES.BRANCH]: ['branch', 'specialization', 'specialisation', 'stream', 'discipline', 'major', 'field of study'],
  [FIELD_TYPES.GRADUATION_YEAR]: ['graduation year', 'year of graduation', 'passing year', 'expected graduation', 'graduation month', 'batch', 'class of', 'year of passing'],
  [FIELD_TYPES.CGPA]: ['cgpa', 'gpa', 'grade point average'],
  [FIELD_TYPES.TENTH_PERCENT]: ['10th percentage', 'tenth percentage', '10th marks', 'class 10', 'ssc', '10th board'],
  [FIELD_TYPES.TWELFTH_PERCENT]: ['12th percentage', 'twelfth percentage', '12th marks', 'class 12', 'hsc', '12th board', 'intermediate'],
  [FIELD_TYPES.GENDER]: ['gender', 'sex', 'gender identity'],
  [FIELD_TYPES.VETERAN_STATUS]: ['veteran', 'military', 'protected veteran'],
  [FIELD_TYPES.DISABILITY_STATUS]: ['disability', 'disabled', 'differently abled'],
  [FIELD_TYPES.SKILLS]: ['skills', 'technical skills', 'technologies', 'competencies', 'skill set'],
  [FIELD_TYPES.LANGUAGES]: ['language', 'languages', 'spoken language', 'known languages', 'language proficiency']
};

// Profile keys whose value is a list. Matched element-wise against option lists.
const LIST_FIELD_TYPES = new Set([FIELD_TYPES.SKILLS, FIELD_TYPES.LANGUAGES]);

// Profile keys that are semantically boolean → Yes/No style options.
const BOOLEAN_FIELD_TYPES = new Set([
  FIELD_TYPES.WORK_AUTHORIZATION,
  FIELD_TYPES.RELOCATION_OK,
  FIELD_TYPES.REMOTE_WORK_OK,
  FIELD_TYPES.VETERAN_STATUS,
  FIELD_TYPES.DISABILITY_STATUS
]);

// Enhancement 6: Field Signature Database (ATS-specific bypass)
const FIELD_SIGNATURES = {
  // Greenhouse patterns
  'candidate[first_name]': FIELD_TYPES.FIRST_NAME,
  'candidate[last_name]': FIELD_TYPES.LAST_NAME,
  'candidate[email]': FIELD_TYPES.EMAIL,
  'candidate[phone]': FIELD_TYPES.PHONE,
  // Lever patterns (removed bare 'name' as it falsely matches unrelated fields)
  'applicant_name': FIELD_TYPES.FULL_NAME,
  'full_name': FIELD_TYPES.FULL_NAME,
  'candidate_name': FIELD_TYPES.FULL_NAME,
  'email': FIELD_TYPES.EMAIL,
  'phone': FIELD_TYPES.PHONE,
  'org': FIELD_TYPES.CURRENT_COMPANY,
  'urls[LinkedIn]': FIELD_TYPES.LINKEDIN_URL,
  'urls[GitHub]': FIELD_TYPES.GITHUB_URL,
  'urls[Portfolio]': FIELD_TYPES.PORTFOLIO_URL,
  // Education / demographics patterns seen on Indian placement + hackathon forms
  'dob': FIELD_TYPES.DOB,
  'date_of_birth': FIELD_TYPES.DOB,
  'birthdate': FIELD_TYPES.DOB,
  'cgpa': FIELD_TYPES.CGPA,
  'cg': FIELD_TYPES.CGPA,
  'degree': FIELD_TYPES.DEGREE,
  'branch': FIELD_TYPES.BRANCH,
  'college': FIELD_TYPES.COLLEGE_NAME,
  'university': FIELD_TYPES.COLLEGE_NAME,
  'institution': FIELD_TYPES.COLLEGE_NAME,
  'batch_year': FIELD_TYPES.GRADUATION_YEAR,
  'graduation_year': FIELD_TYPES.GRADUATION_YEAR,
  'passing_year': FIELD_TYPES.GRADUATION_YEAR,
  'notice_period': FIELD_TYPES.NOTICE_PERIOD,
  'skills': FIELD_TYPES.SKILLS,
  'languages': FIELD_TYPES.LANGUAGES,
  'gender': FIELD_TYPES.GENDER
};

// Enhancement 2: Abbreviation Maps for Fuzzy Dropdown Matching
// NOTE: keys must be lowercase field types (FIELD_TYPES values), not uppercase.
const ABBREVIATION_MAPS = {
  country: {
    'us': ['United States', 'USA', 'United States of America', 'America'],
    'in': ['India', 'IND', 'Bharat'],
    'uk': ['United Kingdom', 'GB', 'Great Britain', 'England'],
    'ca': ['Canada', 'CAN'],
    'au': ['Australia', 'AUS'],
    'de': ['Germany', 'DEU', 'Deutschland'],
    'fr': ['France', 'FRA'],
    'sg': ['Singapore', 'SGP'],
    'ae': ['United Arab Emirates', 'UAE', 'Dubai']
  },
  gender: {
    'm': ['Male', 'Man'],
    'f': ['Female', 'Woman'],
    'o': ['Other', 'Non-binary', 'Nonbinary', 'Decline to self-identify', 'Prefer not to say', 'Rather not say']
  },
  degree: {
    'b.tech': ['BTech', 'B.Tech', 'Bachelor of Technology', 'B Tech', 'B.E.', 'BE', 'Bachelor of Engineering'],
    'm.tech': ['MTech', 'M.Tech', 'Master of Technology', 'M Tech', 'M.E.', 'ME', 'Master of Engineering'],
    'mba': ['MBA', 'Master of Business Administration'],
    'b.sc': ['BSc', 'B.Sc', 'BS', 'Bachelor of Science'],
    'm.sc': ['MSc', 'M.Sc', 'MS', 'Master of Science'],
    'b.a': ['BA', 'B.A.', 'Bachelor of Arts'],
    'm.a': ['MA', 'M.A.', 'Master of Arts'],
    'ph.d': ['PhD', 'Ph.D.', 'Doctorate', 'Doctor of Philosophy'],
    'b.com': ['BCom', 'B.Com', 'Bachelor of Commerce'],
    'bca': ['BCA', 'Bachelor of Computer Applications'],
    'mca': ['MCA', 'Master of Computer Applications'],
    '12th': ['12th', 'HSC', 'Higher Secondary', 'Intermediate', 'Class 12', 'Senior Secondary'],
    '10th': ['10th', 'SSC', 'Secondary', 'Class 10', ' matriculation']
  },
  experience_years: {
    'fresher': ['Fresher', 'Fresher / Entry level', 'Entry level', 'No experience', 'None', '0 years', 'Less than 1', 'Less than 1 year', '0-1 years', '0 - 1 years', 'Up to 1 year'],
    '1-3': ['1-3 years', '1 - 3 years', '1 to 3 years', '2-3 years', '2 - 3 years', '1-2 years'],
    '3-5': ['3-5 years', '3 - 5 years', '3 to 5 years', '4-5 years'],
    '5+': ['5+ years', '5 or more', 'More than 5', '6+ years', '5-10 years', '10+ years'],
    '10+': ['10+ years', '10 or more', 'More than 10', '15+ years']
  },
  total_experience_months: {
    '0-6': ['0-6 months', 'Less than 6 months', 'Under 6 months', '0 - 6 months'],
    '6-12': ['6-12 months', '6 to 12 months', '1 year or less'],
    '12-24': ['1-2 years', '12-24 months', '1 to 2 years'],
    '24-36': ['2-3 years', '24-36 months', '2 to 3 years'],
    '36+': ['3+ years', 'More than 3 years', '36+ months']
  },
  notice_period: {
    'immediate': ['Immediate', 'Immediately', 'Now', '0 days', 'As soon as possible', 'Joining immediately'],
    '15': ['15 days', '15 days notice', 'Within 15 days', 'Half month'],
    '30': ['30 days', '1 month', 'One month', 'Within a month', '30 days notice'],
    '60': ['60 days', '2 months', 'Two months', '60 days notice'],
    '90': ['90 days', '3 months', 'Three months', '90 days notice'],
    '180': ['180 days', '6 months', 'Six months', '180 days notice']
  },
  // The profile column is named notice_period_days, so the map is reachable
  // under both the column name and the plain field name.
  notice_period_days: {
    'immediate': ['Immediate', 'Immediately', 'Now', '0 days', 'As soon as possible', 'Joining immediately'],
    '15': ['15 days', '15 days notice', 'Within 15 days', 'Half month'],
    '30': ['30 days', '1 month', 'One month', 'Within a month', '30 days notice'],
    '60': ['60 days', '2 months', 'Two months', '60 days notice'],
    '90': ['90 days', '3 months', 'Three months', '90 days notice'],
    '180': ['180 days', '6 months', 'Six months', '180 days notice']
  },
  work_authorization: {
    'yes': ['Yes', 'Authorized', 'Authorised', 'Eligible', 'I am authorized', 'Yes, I am authorized'],
    'no': ['No', 'Not authorized', 'Not authorised', 'No sponsorship', 'Will require sponsorship', 'Require sponsorship']
  },
  relocation_ok: {
    'yes': ['Yes', 'Willing to relocate', 'Open to relocation', 'Happy to relocate', 'Yes, willing'],
    'no': ['No', 'Not willing to relocate', 'Unable to relocate', 'No, cannot relocate']
  },
  remote_work_ok: {
    'yes': ['Yes', 'Open to remote', 'Happy to work remotely', 'Yes, remote'],
    'no': ['No', 'Prefer on-site', 'No, on-site only', 'Onsite only', 'No remote']
  },
  veteran_status: {
    'yes': ['Yes', 'I am a veteran', 'Protected veteran', 'Yes, veteran'],
    'no': ['No', 'Not a veteran', 'I am not a veteran', 'No, never served']
  },
  disability_status: {
    'yes': ['Yes', 'I have a disability', 'Yes, disabled'],
    'no': ['No', 'No disability', 'I do not have a disability', 'No, none'],
    'prefer not to say': ['Prefer not to say', 'Decline to self-identify', 'Rather not say', 'Not disclosed', 'Prefer not to disclose']
  }
};

// ── Consent / attestation detection ──
// Checkboxes matching these patterns are always left for the user.
const CONSENT_LABEL_PATTERNS = [
  /\bi\s+agree\b/,
  /\bi\s+accept\b/,
  /\bi\s+consent\b/,
  /\bauthori[sz]e\b/,
  /\bauthori[sz]ation\b/,
  // Matched on the bare verb: legal phrasing is often "I hereby declare…"
  // or "I do hereby acknowledge…", where "i declare" is not adjacent.
  /\bdeclare\b/,
  /\bdeclaration\b/,
  /\bcertify\b/,
  /\backnowledge\b/,
  /\bundertake\b/,
  /\bconsent\b/,
  /\bterms\b/,
  /\bprivacy\b/,
  /\bcookie\b/,
  /\bnewsletter\b/,
  /\bmarketing\b/,
  /\bpromotional\b/,
  /\bopt[\s-]?in\b/,
  /\bsubscribe\b/,
  /\bsign\s*up\b/,
  /\battestation\b/,
  /\bpermission\b/,
  /\bchecked\s+to\s+confirm\b/,
  /\bmandatory\b/,
  /\bdisclaimer\b/
];

function isConsentLabel(label) {
  const l = (label || '').toLowerCase();
  if (!l.trim()) return false;
  return CONSENT_LABEL_PATTERNS.some(re => re.test(l));
}

// Options that require a free-text follow-up. Selecting "Other" is only safe
// when we also have text to put in the follow-up box.
const DEFERRED_OPTION_PATTERNS = [
  /^other\b/,
  /^others\b/,
  /\bother\s*[:(]/,
  /\bnone\s+of\s+(the\s+)?above\b/,
  /^none\b/,
  /\bnil\b/,
  /\bplease\s+specify\b/,
  /\bnot\s+listed\b/,
  /\bsomething\s+else\b/,
  /\bif\s+other\b/,
  /^specify\b/,
  /\bprefer\s+not\s+to\s+say\b/,
  /\bdecline\s+to\b/,
  /\brather\s+not\s+say\b/,
  /\bnot\s+disclose\b/
];

function isDeferredOption(optionText) {
  const t = (optionText || '').trim().toLowerCase();
  if (!t) return false;
  return DEFERRED_OPTION_PATTERNS.some(re => re.test(t));
}

// ── Option text → semantic value ──
// Needed because form options rarely match profile values as plain strings:
// "0-1 years" vs 0, "Graduate" vs "B.Tech", "Yes, I do" vs true.

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};

const TRUE_WORDS = new Set([
  'yes', 'y', 'true', '1', 'on', 'required', 'mandatory', 'eligible', 'authorized',
  'authorised', 'available', 'immediate', 'already', 'done', 'agree', 'agreed', 'accept',
  'accepted', 'confirmed', 'willing', 'able', 'open', 'full time', 'fulltime', 'full-time',
  'employed', 'experienced', 'yes i do', 'yes i have', 'yes i am'
]);

const FALSE_WORDS = new Set([
  'no', 'n', 'false', '0', 'off', 'not required', 'optional', 'ineligible', 'not authorized',
  'not authorised', 'unavailable', 'unwilling', 'unable', 'not interested', 'no i do not',
  'no i do not have', 'no i am not'
]);

/** Pull a boolean out of arbitrary option text. Returns true/false/null. */
function parseBooleanOption(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return null;
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  // Leading yes/no, e.g. "Yes, I am authorized" / "No, I cannot relocate"
  if (/^(yes|y)\b/.test(t)) return true;
  if (/^(no|n)\b/.test(t)) return false;
  return null;
}

/** Coerce a stored profile value to a boolean where possible. */
function coerceBooleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  const b = parseBooleanOption(String(value));
  if (b !== null) return b;
  if (/^(1|true|yes)$/i.test(String(value).trim())) return true;
  if (/^(0|false|no)$/i.test(String(value).trim())) return false;
  return null;
}

/**
 * Parse a numeric range out of option text.
 * Handles "0-1", "2 - 3", "4+", "less than 1", "under 2", "up to 5", "12th",
 * "1 year", "18-24 months". Returns {min, max, isOpenTop} or null.
 */
function parseRangeFromText(text) {
  let t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  t = t.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Bare year/grade markers, e.g. "12th", "10th", "Final year"
  const grade = t.match(/^(\d{1,2})\s*(st|nd|rd|th)$/);
  if (grade) return { min: Number(grade[1]), max: Number(grade[1]), isOpenTop: false, exact: true };

  // Open-ended top: "4+", "4 +", "4 and above", "more than 4", "above 4", "over 4"
  let m = t.match(/^(\d+(?:\.\d+)?)\s*\+/) || t.match(/^(\d+(?:\.\d+)?)\s*(?:and above|or more|and above|plus)\b/);
  if (m) return { min: Number(m[1]), max: Infinity, isOpenTop: true };
  m = t.match(/\b(?:more than|over|above|greater than|at least|minimum)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: Number(m[1]), max: Infinity, isOpenTop: true };

  // "up to", "less than", "under", "within", "below" → 0..n
  m = t.match(/\b(?:up to|less than|under|within|below|not more than|at most|max)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: 0, max: Number(m[1]) - 1, isOpenTop: false };

  // "under 1 year" handled above; guard the common "1 year or less"
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:year|yr)s?\s*or\s*(?:less|fewer)/);
  if (m) return { min: 0, max: Number(m[1]), isOpenTop: false };

  // "2-3 years", "2 to 3", "2 - 3 yrs", "2-3"
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to|and)\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return { min: Math.min(a, b), max: Math.max(a, b), isOpenTop: false };
  }

  // Single number, e.g. "2 years", "18-24 months" already handled
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:year|yr|month|month s|months|annum)s?\b/);
  if (m) return { min: Number(m[1]), max: Number(m[1]), isOpenTop: false, exact: true };
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return { min: Number(m[1]), max: Number(m[1]), isOpenTop: false, exact: true };

  return null;
}

/** Coerce a stored profile value to a number where possible. */
function coerceNumericValue(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const ORDINAL_WORDS = {
  first: 1, '1st': 1, one: 1,
  second: 2, '2nd': 2, two: 2,
  third: 3, '3rd': 3, three: 3,
  fourth: 4, '4th': 4, four: 4,
  fifth: 5, '5th': 5, five: 5,
  sixth: 6, '6th': 6, six: 6,
  seventh: 7, '7th': 7, seven: 7,
  eighth: 8, '8th': 8, eight: 8,
  ninth: 9, '9th': 9, nine: 9,
  tenth: 10, '10th': 10, ten: 10
};

function parseOrdinal(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(ORDINAL_WORDS, t)) return ORDINAL_WORDS[t];
  const m = t.match(/^(\d{1,2})(?:st|nd|rd|th)\b/);
  if (m) return Number(m[1]);
  // A bare small integer is an ordinal too: options "First / Second / Third"
  // asked by a stored value of "2".
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= 20) return n;
  }
  return null;
}

// ── Date normalization ──
// A stored profile value ("15/01/2000", "Jan 2000", "January 15, 2000") has to
// become whatever the control actually accepts: YYYY-MM-DD, YYYY-MM, HH:MM.

// Cached per control element: 'dmy' or 'mdy', inferred from the placeholder.
function detectDateOrder(el) {
  if (!el) return null;
  const ph = ((el.getAttribute && el.getAttribute('placeholder')) || '').toLowerCase();
  if (!ph) return null;
  const first = ph.match(/\b(dd?|mm?|yyyy?|yy)\b/);
  if (!first) return null;
  if (first[1] === 'mm' && /\byyyy|\byy/.test(ph)) {
    // "mm/yyyy" is a month-first placeholder but has no day component
    return 'mdy';
  }
  if (first[1] === 'mm') return 'mdy';
  if (first[1] === 'dd') return 'dmy';
  if (first[1] === 'yyyy') return null;
  return null;
}

function _pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * Normalize a raw date-ish value into a structured date object.
 * Returns {y, m, d, hh, mm} or null. Never throws.
 */
function parseDateParts(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.y) return { y: raw.y, m: raw.m || 1, d: raw.d || 1, hh: raw.hh || 0, mm: raw.mm || 0 };
  }
  let s = String(raw).trim();
  if (!s) return null;

  // Already ISO
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] ? +m[4] : 0, mm: m[5] ? +m[5] : 0 };

  // ISO-ish with slashes: 2000/01/15
  m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hh: 0, mm: 0 };

  // 15-Jan-2000 / 15 Jan 2000 / 15th January 2000
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]+([a-z]{3,9})[\s\-/.]+(\d{4})$/i);
  if (m) {
    const mo = MONTH_NAMES[String(m[2]).toLowerCase()];
    if (mo) return { y: +m[3], m: mo, d: +m[1], hh: 0, mm: 0 };
  }

  // January 15, 2000 / January 15 2000 / Jan 2000 (no day)
  m = s.match(/^([a-z]{3,9})[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.]+(\d{4})$/i);
  if (m) {
    const mo = MONTH_NAMES[String(m[1]).toLowerCase()];
    if (mo) return { y: +m[3], m: mo, d: +m[2], hh: 0, mm: 0 };
  }
  m = s.match(/^([a-z]{3,9})[\s\-/.,]+(\d{4})$/i);
  if (m) {
    const mo = MONTH_NAMES[String(m[1]).toLowerCase()];
    if (mo) return { y: +m[2], m: mo, d: 1, hh: 0, mm: 0 };
  }

  // Pure numeric triple: 15/01/2000, 01/15/2000, 15-01-2000, 2000.01.15
  m = s.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
  if (m) {
    let a = +m[1], b = +m[2], c = +m[3];
    if (m[1].length === 4) return { y: a, m: b, d: c, hh: 0, mm: 0 };   // yyyy-mm-dd
    if (m[3].length === 4) {
      // d/m/y vs m/d/y — disambiguate when one value can't be a day.
      if (a > 12 && b <= 12) return { y: c, m: b, d: a, hh: 0, mm: 0 };       // definitely d/m/y
      if (b > 12 && a <= 12) return { y: c, m: a, d: b, hh: 0, mm: 0 };       // definitely m/d/y
      return { y: c, m: a, d: b, hh: 0, mm: 0, ambiguous: true };            // default m/d/y
    }
    // yymmdd
    if (m[1].length === 4) return { y: a, m: b, d: c, hh: 0, mm: 0 };
    return null;
  }

  // Compact 8-digit: 20000115
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hh: 0, mm: 0 };

  // Year only
  m = s.match(/^(\d{4})$/);
  if (m) return { y: +m[1], m: 1, d: 1, hh: 0, mm: 0 };

  // Year + month
  m = s.match(/^([a-z]{3,9})\s+(\d{4})$/i);
  if (m) {
    const mo = MONTH_NAMES[String(m[1]).toLowerCase()];
    if (mo) return { y: +m[2], m: mo, d: 1, hh: 0, mm: 0 };
  }
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: 1, hh: 0, mm: 0 };

  // Time-only
  m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) {
    let hh = +m[1];
    const ampm = (m[4] || '').toLowerCase();
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
    return { y: 1970, m: 1, d: 1, hh, mm: +m[2] };
  }

  return null;
}

/**
 * Format a raw date-ish value for a given control kind.
 * `order` ('dmy' | 'mdy') resolves ambiguous numeric dates.
 * Returns null when the value cannot be understood — the caller reports
 * `no-value` rather than writing garbage.
 */
function normalizeDateValue(raw, kind, order) {
  const p = parseDateParts(raw);
  if (!p) return null;

  const y = p.y;
  const mo = p.m;
  const d = p.d;
  if (!y || y < 1000 || y > 3000) return null;
  if (!mo || mo < 1 || mo > 12) return null;
  if (!d || d < 1 || d > 31) return null;

  switch (kind) {
    case FIELD_KIND.DATE:
      return `${y}-${_pad(mo, 2)}-${_pad(d, 2)}`;
    case FIELD_KIND.MONTH:
      return `${y}-${_pad(mo, 2)}`;
    case FIELD_KIND.DATETIME:
      return `${y}-${_pad(mo, 2)}-${_pad(d, 2)}T${_pad(p.hh || 0, 2)}:${_pad(p.mm || 0, 2)}`;
    case FIELD_KIND.TIME:
      return `${_pad(p.hh || 0, 2)}:${_pad(p.mm || 0, 2)}`;
    case FIELD_KIND.DATE_PARTS: {
      const dayFirst = order !== 'mdy';
      return dayFirst
        ? { dd: _pad(d, 2), mm: _pad(mo, 2), yyyy: String(y) }
        : { mm: _pad(mo, 2), dd: _pad(d, 2), yyyy: String(y) };
    }
    default:
      return `${y}-${_pad(mo, 2)}-${_pad(d, 2)}`;
  }
}

// ── Composite rules ──
const COMPOSITE_RULES = {
  [FIELD_TYPES.FULL_NAME]: (profile) => {
    if (profile[FIELD_TYPES.FIRST_NAME] && profile[FIELD_TYPES.LAST_NAME]) {
      return `${profile[FIELD_TYPES.FIRST_NAME]} ${profile[FIELD_TYPES.LAST_NAME]}`;
    }
    return profile[FIELD_TYPES.FIRST_NAME] || profile[FIELD_TYPES.LAST_NAME] || '';
  },
  // If address is requested as a single text area
  'full_address': (profile) => {
    const parts = [
      profile[FIELD_TYPES.ADDRESS_LINE1],
      profile[FIELD_TYPES.CITY],
      profile[FIELD_TYPES.STATE],
      profile[FIELD_TYPES.PINCODE],
      profile[FIELD_TYPES.COUNTRY]
    ].filter(Boolean);
    return parts.join(', ');
  }
};

const SKIP_SECTIONS = [
  'emergency contact',
  'references',
  'reference',
  'manager',
  'supervisor',
  'father',
  'mother',
  'parent',
  'guardian',
  'spouse',
  'nominee',
  'family',
  'next of kin'
];

// Fields that should never be saved as corrections or autofilled.
const SENSITIVE_FIELD_KEYWORDS = [
  'password', 'passwd',
  'card number', 'card no', 'credit card', 'debit card',
  'cvv', 'cvc', 'security code',
  'ssn', 'social security',
  'bank account', 'account number', 'routing number',
  'security pin', 'secret', 'token',
  'otp', 'verification code',
  'aadhaar', 'aadhar', 'pan number', 'passport number'
];

// Optional demographic values require a separate, explicit user preference.
const PROTECTED_DEMOGRAPHIC_KEYWORDS = [
  'gender', 'sex', 'race', 'ethnicity', 'disability', 'veteran',
  'marital status', 'religion', 'sexual orientation'
];

// Section headings that turn a bare checkbox into an "I agree" consent box.
const CONSENT_SECTION_HINTS = [
  'consent', 'terms', 'declaration', 'attestation', 'agreement',
  'acknowledgement', 'acknowledgment', 'privacy', 'permission'
];
