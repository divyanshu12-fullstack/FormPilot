// ── FormPilot Constants ──
// Defines field types, keywords, and mapping rules

const FIELD_TYPES = {
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  FULL_NAME: 'full_name',
  EMAIL: 'email',
  PHONE: 'phone',
  ADDRESS_LINE1: 'address_line1',
  CITY: 'city',
  STATE: 'state',
  PINCODE: 'pincode',
  COUNTRY: 'country',
  LINKEDIN_URL: 'linkedin_url',
  GITHUB_URL: 'github_url',
  PORTFOLIO_URL: 'portfolio_url',
  CURRENT_TITLE: 'current_title',
  CURRENT_COMPANY: 'current_company',
  EXPERIENCE_YEARS: 'experience_years',
  WORK_AUTHORIZATION: 'work_authorization',
  GENDER: 'gender',
  VETERAN_STATUS: 'veteran_status',
  DISABILITY_STATUS: 'disability_status'
};

const FIELD_KEYWORDS = {
  [FIELD_TYPES.FIRST_NAME]: ['first name', 'given name', 'fname'],
  [FIELD_TYPES.LAST_NAME]: ['last name', 'family name', 'surname', 'lname'],
  [FIELD_TYPES.FULL_NAME]: ['full name', 'name', 'applicant name', 'candidate name'],
  [FIELD_TYPES.EMAIL]: ['email', 'e-mail', 'email address'],
  [FIELD_TYPES.PHONE]: ['phone', 'mobile', 'telephone', 'cell'],
  [FIELD_TYPES.ADDRESS_LINE1]: ['address', 'street', 'street address', 'address line 1', 'line 1'],
  [FIELD_TYPES.CITY]: ['city', 'town'],
  [FIELD_TYPES.STATE]: ['state', 'province', 'region'],
  [FIELD_TYPES.PINCODE]: ['zip', 'postal', 'pincode', 'zip code'],
  [FIELD_TYPES.COUNTRY]: ['country', 'nation'],
  [FIELD_TYPES.LINKEDIN_URL]: ['linkedin', 'linked in', 'linkedin profile', 'linkedin url'],
  [FIELD_TYPES.GITHUB_URL]: ['github', 'git hub', 'github url'],
  [FIELD_TYPES.PORTFOLIO_URL]: ['portfolio', 'website', 'personal website', 'url', 'link'],
  [FIELD_TYPES.CURRENT_TITLE]: ['title', 'current title', 'job title', 'role'],
  [FIELD_TYPES.CURRENT_COMPANY]: ['company', 'current company', 'employer'],
  [FIELD_TYPES.EXPERIENCE_YEARS]: ['experience', 'years of experience', 'yoe'],
  [FIELD_TYPES.WORK_AUTHORIZATION]: ['authorization', 'authorized', 'visa', 'sponsorship', 'sponsor', 'right to work'],
  [FIELD_TYPES.GENDER]: ['gender', 'sex', 'gender identity'],
  [FIELD_TYPES.VETERAN_STATUS]: ['veteran', 'military', 'protected veteran'],
  [FIELD_TYPES.DISABILITY_STATUS]: ['disability', 'disabled']
};

const CONFIDENCE_COLORS = {
  HIGH: '#2d8a4e',    // Heuristic match
  MEDIUM: '#c4930a',  // LLM matched
  DRAFT: '#2b6cb0'    // AI drafted long answer
};

// Enhancement 6: Field Signature Database (ATS-specific bypass)
const FIELD_SIGNATURES = {
  // Greenhouse patterns
  'candidate[first_name]': FIELD_TYPES.FIRST_NAME,
  'candidate[last_name]': FIELD_TYPES.LAST_NAME,
  'candidate[email]': FIELD_TYPES.EMAIL,
  'candidate[phone]': FIELD_TYPES.PHONE,
  // Lever patterns
  'name': FIELD_TYPES.FULL_NAME, // Lever often uses 'name' for full name
  'email': FIELD_TYPES.EMAIL,
  'phone': FIELD_TYPES.PHONE,
  'org': FIELD_TYPES.CURRENT_COMPANY,
  'urls[LinkedIn]': FIELD_TYPES.LINKEDIN_URL,
  'urls[GitHub]': FIELD_TYPES.GITHUB_URL,
  'urls[Portfolio]': FIELD_TYPES.PORTFOLIO_URL
};

// Enhancement 2: Abbreviation Maps for Fuzzy Dropdown Matching
const ABBREVIATION_MAPS = {
  COUNTRY: {
    'US': ['United States', 'USA', 'United States of America'],
    'IN': ['India', 'IND'],
    'UK': ['United Kingdom', 'GB', 'Great Britain']
  },
  GENDER: {
    'M': ['Male', 'Man'],
    'F': ['Female', 'Woman'],
    'O': ['Other', 'Non-binary', 'Decline to self-identify', 'Prefer not to say']
  }
};

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
  'supervisor'
];



