# FormPilot — Edge and Firefox Store Launch Scope

This document defines the first store release. It is the product boundary for implementation and testing.

## Product

FormPilot is a local-first, user-triggered form autofiller. It fills supported fields from information the user has explicitly entered or confirmed, and leaves uncertain fields untouched.

## Launch targets

- **Stores:** Microsoft Edge Add-ons and Firefox Add-ons.
- **Browsers under test:** Stable Microsoft Edge (Chromium) and stable Firefox desktop.
- Use the shared WebExtensions API surface where possible. Keep browser-specific manifest entries or packaging only where the stores require them.

## In scope

- A user-managed profile stored in the browser's local extension storage.
- User-triggered autofill with a clear summary of filled, skipped, and failed fields.
- Conservative matching from exact labels, reviewed aliases, known field signatures, and user-confirmed corrections.
- Editable and deletable corrections keyed by exact field label. Older site-specific
  corrections keep their original domain.
- Google Forms, Microsoft Forms, and supported standard HTML controls, verified in Edge and Firefox.
- Local profile import/export and a delete-all-data control.
- Simple, high-contrast monochrome UI with understandable status text and keyboard-accessible controls.
- An optional external support/donation link that does not affect functionality.

## Out of scope for the first release

- Resume upload, resume parsing, and resume-derived profile data.
- AI field mapping, AI-generated answers, sparkle/star controls, and auto-draft mode.
- A hosted backend, user accounts, cloud profile storage, or cloud sync.
- Form submission, CAPTCHA handling, and automatic agreement/attestation acceptance.
- Chrome Web Store release and Chrome-only testing.

## Autofill safety contract

- Autofill only after an explicit user action on the current page.
- Never overwrite a non-empty value the user entered.
- Never infer or automatically fill sensitive credentials, financial identifiers, government IDs, or legally significant answers.
- Saved demographic values (for example gender or veteran status) fill only as part of an explicit user-initiated fill, like any other profile field.
- Fill only when the field and value have one clear, supported match. Otherwise skip and report why.
- Verify each attempted fill against the control's resulting value or selected state. Do not report an unverified attempt as successful.
- FormPilot does not submit the form.

## Data and network boundary

- Profile and correction data are stored in the browser's local extension storage and are not sent to a FormPilot server.
- Local browser storage is not represented as encrypted storage. The UI must describe it accurately and provide export and deletion controls.
- The core autofill flow must work without an internet connection or separately installed service.
- Do not include profile values or correction values in diagnostic logs.

## Edge and Firefox release acceptance

A release candidate must:

1. Install unpacked in clean Edge and Firefox profiles and complete the core flow without a backend, API key, or internet connection.
2. Request access only as needed for the user-triggered current-page flow in both browsers.
3. Pass browser-based tests in Edge and Firefox for supported text fields, dates, selects, radios, checkboxes, dynamic/conditional fields, and failed or ambiguous matches.
4. Verify the supported Google Forms and Microsoft Forms flows in both browsers without submitting a real form.
5. Leave ambiguous and blocked fields unchanged, and report skips or failures honestly.
6. Produce store-ready packages and accurate listing/privacy information for both Edge Add-ons and Firefox Add-ons.
