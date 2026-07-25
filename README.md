# ✈️ FormPilot

**A local-first, privacy-respecting, AI-powered form autofiller for Chrome.**

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-local%20storage-003B57?logo=sqlite&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)

FormPilot fills out placement applications, hackathon registrations, and college forms automatically — resolving most fields locally in under 5ms, and calling an LLM only for the fields it genuinely can't figure out on its own. Every piece of your data, from your resume to your corrections, stays in a SQLite database on your own machine.

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [How It Works](#how-it-works)
  - [Heuristic-First Cascade](#heuristic-first-cascade-5ms-fully-local)
  - [3-Phase Interactive AI System](#3-phase-interactive-ai-system)
  - [Token-Efficient Resume Parsing](#token-efficient-resume-parsing)
  - [Corrections Learning Loop](#corrections-learning-loop)
  - [Confidence Marking](#confidence-marking)
  - [Handling Google & Microsoft Forms](#handling-google--microsoft-forms)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Privacy](#privacy)
- [Roadmap](#roadmap)

---

## Why This Exists

As a final-year student, I was retyping the same information — name, education, experience — into placement applications, hackathon registrations, and college event forms, every single day. Windows had no equivalent to the native autofill mobile operating systems ship with by default, so I built one.

What started as a simple regex-based field matcher has grown into a hybrid system: resume parsing, a local-first heuristic cascade, and a token-conscious LLM fallback reserved only for fields that are genuinely ambiguous.

## How It Works

### Heuristic-First Cascade (<5ms, fully local)

When you click **Autofill**, every field passes through four local checks before an LLM is ever considered:

1. **Corrections DB check** — has the user manually corrected this field label before?
2. **Signature DB check** — does it match a known ATS element ID (e.g., `applicant_email`)?
3. **Exact label match** — does it match a profile schema key directly?
4. **Keyword & abbreviation mapping** — central maps handle variants like `"US"` → `"United States"`, `"F"` → `"Female"`.

This resolves roughly **85% of standard form fields instantly**, without a single call to an external API. If every field on a form is already covered by stored data, the extension skips the LLM request entirely rather than making a wasted call.

### 3-Phase Interactive AI System

The first version fully automated anything the local database couldn't resolve, sending it straight to an LLM in the background. In practice, this wasted tokens and occasionally hallucinated answers to deeply personal questions (e.g., *"Why did your grades drop?"*). It was redesigned into three phases:

1. **Instant Static Fill** — every determinable field fills immediately from the local database, with zero LLM calls and zero latency.
2. **Inline AI Assist ("Sparkle" UI)** — a subtle ✨ icon appears on any unfilled, ambiguous field. Clicking it opens a small dialog where you can give brief guidance (e.g., *"mention my health issues in semester 4"*), and the LLM is invoked only for that one field.
3. **Opt-in Speed Mode** — a toggle for power users who'd rather skip the Sparkle UI and let the extension auto-draft every remaining field in the background.

### Token-Efficient Resume Parsing

Instead of re-sending the raw resume file to the LLM on every form fill, FormPilot makes **one** LLM call at upload time to convert the parsed resume into structured JSON, stored alongside the profile. Every autofill afterward reuses that structured data — the LLM only ever sees form labels and schema keys, never raw resume text or private values. This cut per-upload token usage from **12K+ tokens down to under 10K** across 5+ form fills.

### Corrections Learning Loop

Some fields — a CGPA, a registration number — don't exist in any resume or profile schema, and no LLM can invent them. Corrections close that gap: if you manually fill an empty field, the extension detects the change, saves it to a local Corrections DB, and fills it automatically the next time that field appears — no LLM call needed.

### Confidence Marking

Filled fields are color-coded so you know what's safe to trust and what's worth a second look:

| Color | Meaning |
|---|---|
| 🟢 Green | Filled deterministically from the local DB |
| 🟡 Plum/Yellow | LLM-mapped to existing profile or resume data |
| 🔵 Blue | Fully custom, LLM-drafted response |

### Handling Google & Microsoft Forms

Google Forms and Microsoft Forms don't use plain `<input>` elements — they're built from deeply nested, dynamically rendered `<div>` structures. FormPilot uses **seven fallback strategies** to identify fields correctly: `label-for`, `aria-label`, `aria-labelledby`, wrapping label, proximity walk, and placeholder — falling back to spatial matching as a last resort when everything else fails.

## Tech Stack

- **Extension:** Manifest V3, vanilla HTML/CSS/JS — no React, no bundler overhead, for instant load times and the smallest possible footprint
- **Backend:** FastAPI + SQLite3
- **Resume parsing:** `pdfplumber`, `python-docx` (chosen over Node.js equivalents for reliability on real-world resumes)
- **LLM layer:** OpenRouter, invoked only when local heuristics can't confidently resolve a field

## Getting Started

### Prerequisites

- [Python 3.10+](https://www.python.org/downloads/)
- [uv](https://github.com/astral-sh/uv) — fast Python package installer and resolver

### 1. Start the Backend

```bash
cd backend
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8420
```

Press `Ctrl+C` in the terminal at any time to stop the server.

### 2. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension` folder from this repository
4. Pin the FormPilot icon to your toolbar

## Privacy

All data — resumes, profile fields, corrections — lives in a local SQLite database on your machine. The only data that ever leaves your device is the minimum context needed for an LLM to map an ambiguous form label to a schema key; raw personal values are never sent as part of that request.

## Roadmap

- **Fully offline mode** via local, WebGPU-accelerated transformer models — no API key required.

---

Built to help students and professionals get through repetitive forms faster, so you can focus on what actually matters.
