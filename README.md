<img src="extension/icons/icon-128.png" alt="FormPilot" width="96" align="right">

# FormPilot

**A local-first form autofiller for Edge and Firefox.**

FormPilot fills the fields it can match with certainty — names, email, phone, education,
skills, work history — and leaves everything else alone for you to review. Your profile
never leaves your browser: there is no backend, no account, and no network request.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [What it does](#what-it-does)
- [Safety contract](#safety-contract)
- [Privacy](#privacy)
- [Install](#install)
- [How to use it](#how-to-use-it)
- [How matching works](#how-matching-works)
- [Supported fields and pages](#supported-fields-and-pages)
- [Project layout](#project-layout)
- [Development](#development)
- [Limitations](#limitations)
- [Status](#status)

---

## Why it exists

Placements, hackathons, and college forms all ask the same dozen questions in slightly
different wording. Retyping them is tedious and error-prone, and generic browser autofill
usually cannot map "Branch" or "CGPA" to anything useful.

FormPilot does one narrow thing well: it matches a form field to a value **you** saved,
and only when there is exactly one sensible match.

## What it does

- **Profile-based filling.** Save your details once in the options page; FormPilot fills
  matching fields whenever you ask it to.
- **Learned corrections.** When you correct a field FormPilot got wrong, it remembers that
  correction for that site and uses it next time.
- **Honest results.** The popup reports what was filled, skipped and failed, and why —
  per field.
- **Privacy and data controls.** Export a backup, import one, or delete everything stored
  in the browser.
- **Works offline.** The extension makes no network requests at all.

## Safety contract

- Fills only after an explicit action you take on the current page.
- Never overwrites a value you already entered.
- Never fills credentials, payment details, government IDs or similar sensitive fields.
- Never ticks a consent, agreement or attestation checkbox.
- Fills only when a field has one clear, supported match; anything ambiguous is skipped
  and reported.
- Verifies every attempted fill against the control's resulting value, and rolls back if
  the value did not stick.
- Never submits a form.

Saved demographic values (gender, marital status, veteran status, disability status) are
treated like any other profile field: they fill only as part of a fill you start.

## Privacy

- Profile and corrections live in `browser.storage.local` — in your browser profile, on
  your machine. They are not encrypted by the browser, and the UI says so.
- The extension has no backend, no analytics, no telemetry and no outbound network
  requests. The only permissions it asks for are `storage`, `activeTab` and `scripting`,
  all of which are needed to read your saved profile and fill the page in front of you.
- Deleting your data in *Privacy & data* removes the profile and every learned
  correction from the browser.

## Install

### Edge (Chromium)

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the `extension` folder from this repository.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and pick `extension/manifest.json`.

Firefox 142 or newer is required. The store builds are produced by `scripts/package.js`.

### Chrome

Chrome support is planned and can be turned on on demand — the extension already uses the
shared WebExtensions API surface that Chrome supports, so it is a packaging question
rather than a rewrite.

## How to use it

1. Open the options page (click the toolbar icon, then **Profile & settings**) and fill
   in the details you want FormPilot to use.
2. Press **Save profile**. The data is written to this browser only.
3. Open the form you want to fill and click the FormPilot toolbar icon.
4. The popup tells you what it found: ready to fill, nothing to fill, no supported fields,
   or a page it cannot touch.
5. Press **Fill this page**, then review the highlighted fields before you submit. The
   popup lists every field it filled, skipped or failed, with the reason.

## How matching works

For each field, in order:

1. **Learned corrections** — did you correct this label on this site before?
2. **Field signatures** — known element names used by applicant tracking systems.
3. **Exact label match** — the label matches a profile key directly.
4. **Keyword and alias maps** — reviewed variants such as `F` → `Female` or `US` →
   `United States`.

The first match with one clear answer wins. If two profile fields could answer a label,
or the saved value has no counterpart in the control's options, the field is skipped and
the reason is shown.

## Supported fields and pages

| Category | Covered |
| --- | --- |
| Inputs | text, textarea, email, tel, url, number |
| Dates | `date`, `month`, `time`, `datetime-local`, separate day/month/year boxes, flatpickr-style readonly inputs |
| Choices | `select`, multi-select, radio groups, checkbox groups, custom dropdowns |
| Pages | Standard HTML forms, Google Forms, Microsoft Forms, Select2, Bootstrap selects, MUI selects, shadow DOM, same-origin iframes |

## Project layout

```
extension/            The extension itself
  background.js       Service worker (Chromium) / event page (Firefox)
  content_script.js   Page scanning, matching, verified filling, frame relay
  options.*           Profile, learned corrections, privacy and data
  popup.*             Page-state detection and fill results
  shared/             constants, matching rules, widgets, storage
  icons/              Brand mark and generated PNG sizes
  test/               Fixtures and test harnesses
scripts/
  generate-icons.js   Rasterizes icons/icon.svg into PNGs
  package.js          Builds the Edge and Firefox store packages
dist/                 Generated packages (not committed)
```

## Development

```bash
# Logic tests
node extension/test/run_logic_tests.js

# Storage tests
node extension/test/run_storage_tests.js

# DOM integration tests (needs a static server on port 8899)
python -m http.server 8899
node extension/test/run_dom_tests.js 'http://127.0.0.1:8899/extension/test/test_runner.html?autorun=1'

# Edge smoke test (loads the extension unpacked)
node extension/test/run_edge_extension_smoke.js

# Regenerate the PNG icons from extension/icons/icon.svg
node scripts/generate-icons.js

# Build both store packages into dist/
node scripts/package.js

# Lint the Firefox package (requires Node and network access)
npx web-ext lint --source-dir dist/staging/firefox
```

## Limitations

- Cross-origin iframes cannot be reached; FormPilot reports them instead of guessing.
- There is no resume parsing, no AI mapping and no auto-draft mode.
- Ambiguous fields are skipped on purpose — a blank field is easier to fix than a wrong one.
- The extension fills controls it understands; unusual custom widgets can be skipped.

## Status

- Core filling, matching, corrections and storage: complete and covered by tests.
- Edge and Firefox packages build cleanly; the Firefox package passes `web-ext lint`
  with no errors or warnings.
- Store submission and the final visual pass in Firefox are still ahead.
- Chrome is planned, on demand.
