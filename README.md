# ✈️ FormPilot

**The local-first, privacy-respecting, AI-powered form autofiller.**

## 📖 The Story Behind FormPilot

As a final-year student, I was drowning in a sea of identical forms—placement applications, hackathon registrations, college events. Every single day required me to re-type the exact same information on my laptop. It bugged me endlessly: *Why do I have to do this boring, repetitive task manually every time? Why isn't there an automatic form filler for PC that works as seamlessly as mobile native autofill?*

So, I set out to build my own solution. **FormPilot** was born. 

What started as a simple extension using regex to identify input fields and autofill them with a click has evolved into a powerhouse. I integrated Resume parsing (extracting Name, Job, Experience, etc.) and stored everything in a **local SQLite database** so your personal info remains completely safe and secured on your machine.

## 🚀 Key Features & Architecture

### 1. Robust Local Foundation
- **Better Parsing:** I chose `pdfplumber` and `python-docx` for resume parsing over Node.js counterparts because they are significantly more robust and reliable. 
- **FastAPI Backend:** Python is the Lingua Franca of LLMs. Coupling it with a solid SQLite3 database via FastAPI made far more sense than a bloated Node/Express setup.
- **Ultra-Lightweight Frontend:** The extension uses vanilla HTML, CSS, and JS. No React, no heavy libraries. The result? Instantaneous load speeds, microscopic bundle sizes, and the fastest possible response times.

### 2. The Heuristic-First Cascade (Runs locally in <5ms)
Why rely on AI for everything when we can do it faster and cheaper? When you click Autofill, fields pass through a strict local check before AI is even considered:
1. **Corrections DB Check:** Has the user manually corrected this field label before?
2. **Signature DB Check:** Matches known ATS element IDs (e.g., `applicant_email`).
3. **Exact Label Match:** Matches exact profile schema keys.
4. **Keyword & Abbreviation Mapping:** Central maps for variants (e.g., "US" matches "United States", "F" matches "Female").

*Result: ~85% of standard form fields are filled instantly on your machine without contacting any external API.*

### 3. The 3-Phase Interactive AI System
Initially, I tried fully automating unknown fields with LLMs. It was a disaster—wasted tokens, high latency, and hallucinated answers to personal questions (e.g., *"Why did your grades drop?"*). 

To fix this, I pivoted to a **3-Phase Interactive Architecture**:
1. **Instant Static Fill (Zero-Latency):** Fills all determinable fields instantly using the local DB.
2. **Inline AI Assist (The Sparkle ✨ UI):** Injects a subtle "✨" icon into unfilled, ambiguous inputs. Clicking it opens a mini-dialog where you can provide brief guidance (*"Mention my health issues in semester 4"*). The LLM is invoked *only* for that specific field, saving tokens and ensuring accuracy.
3. **Opt-in "Speed Mode":** For power users, a settings toggle bypasses the Sparkle UI and auto-drafts all remaining fields in the background.

### 4. The "Corrections" Learning Loop
LLMs can map "Years of experience" to your resume, but they can't invent your "CGPA" or "Registration No". These are user-specific data points that don't exist in a standard profile schema.
FormPilot solves this with a **personal key-value store that grows over time**: If you manually fill an empty field, the extension detects the change, saves it to the local Corrections DB, and will automatically fill it the *next* time it sees it—no LLM needed!

### 5. Human-in-the-Loop Grading (Confidence Marking)
To ensure complete transparency and let users know which fields need review based on how they were filled, FormPilot implements color-coded UI highlights:
- **Green (High Confidence):** Filled deterministically from your local DB.
- **Plum/Yellow (Medium Confidence):** The LLM mapped the field to an existing profile/resume data point.
- **Blue (Draft):** The LLM generated a custom contextual response.

## 🛠️ Overcoming the DOM Nightmare
The biggest challenge was hitting target platforms like Google Forms and Microsoft Forms. They don't use simple `<input>` tags; they use heavily nested, dynamically rendered `<div>` elements. 
FormPilot uses **7 fallback mechanisms** to get the fields right (label-for, aria-label, aria-labelledby, wrapping label, proximity walk, placeholder), and finally relies on **spatial matching** as a last resort.

## ⚙️ Installation & Setup (Local Privacy)
Because FormPilot is built for complete privacy, you must run the backend locally on your own machine. Your data never leaves your computer (except for LLM mapping via OpenRouter if a field cannot be matched locally).

### Prerequisites
- Install Python 3.10+
- Install `uv` (Fast Python package installer and resolver)

### 1. Start the Backend Server
Open your terminal and navigate to the backend folder:
```bash
cd backend
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8420
```
*Note: To turn the server off at any time, simply press `Ctrl + C` in the terminal window where it is running, or close the terminal window entirely.*

### 2. Load the Extension in Chrome
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `extension` folder from this repository.
4. Pin the FormPilot icon to your browser toolbar!

## 🔮 Future Scope
- **Fully Offline Mode:** Integration with local LLM models via WebGPU-accelerated Transformers, allowing for 100% offline usage without an API key.

---
*Built to help students and professionals fly through forms, so you can focus on what actually matters.*
