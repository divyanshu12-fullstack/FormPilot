import datetime
import io
import os
import re
import httpx
import json
from typing import Optional, List
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, field_validator
import pdfplumber
import docx
from sqlalchemy import select, insert, update, delete
from sqlalchemy.exc import SQLAlchemyError
from dotenv import load_dotenv

load_dotenv()
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")

from contextlib import asynccontextmanager

from db import engine, profile, resume, corrections, init_db

class CorrectionRequest(BaseModel):
    field_label: str
    corrected_value: str
    field_kind: str = "value"  # "value" (plain text) | "option" (a choice label)

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="FormPilot API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def call_openrouter(messages, response_format=None):
    if not OPENROUTER_API_KEY:
        raise HTTPException(status_code=500, detail="OpenRouter API key is missing")
    
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "HTTP-Referer": "http://localhost:8420",
        "X-Title": "FormPilot",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": messages,
    }
    if response_format:
        payload["response_format"] = response_format
        
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload, timeout=45.0)
            resp.raise_for_status()
            data = resp.json()
            if "choices" not in data or not data["choices"]:
                raise HTTPException(status_code=502, detail="OpenRouter returned an empty choices array")
            return data["choices"][0]["message"]["content"]
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="OpenRouter API request timed out")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"OpenRouter API error: {e.response.text}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"LLM call failed: {str(e)}")

class ProfileSchema(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address_line1: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    country: Optional[str] = None
    linkedin_url: Optional[str] = None
    github_url: Optional[str] = None
    portfolio_url: Optional[str] = None
    current_title: Optional[str] = None
    current_company: Optional[str] = None
    experience_years: Optional[int] = None
    work_authorization: Optional[str] = None
    gender: Optional[str] = None
    veteran_status: Optional[str] = None
    disability_status: Optional[str] = None
    # ── Choice-control fields ──
    # Extra keys are preserved rather than silently dropped, so a field added
    # to options.html can never be accepted by the UI and then discarded here.
    # (This is how "cgpa" was being lost: the input existed, the schema did not.)
    model_config = ConfigDict(extra="allow")

    dob: Optional[str] = None
    cgpa: Optional[str] = None
    degree: Optional[str] = None
    branch: Optional[str] = None
    college_name: Optional[str] = None
    graduation_year: Optional[str] = None
    tenth_percent: Optional[str] = None
    twelfth_percent: Optional[str] = None
    skills: Optional[List[str]] = None
    languages: Optional[List[str]] = None
    notice_period_days: Optional[int] = None
    preferred_location: Optional[str] = None
    relocation_ok: Optional[str] = None
    remote_work_ok: Optional[str] = None
    total_experience_months: Optional[int] = None
    marital_status: Optional[str] = None
    blood_group: Optional[str] = None

    @field_validator("skills", "languages", mode="before")
    @classmethod
    def _split_list(cls, v):
        """The settings form sends a comma-separated string; the API and the
        resume parser send a real list. Accept either."""
        if v is None or isinstance(v, list):
            return v
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            if s.startswith("["):
                try:
                    parsed = json.loads(s)
                    if isinstance(parsed, list):
                        return parsed
                except (ValueError, TypeError):
                    pass
            return [item.strip() for item in re.split(r"[,;\n|]", s) if item.strip()]
        return v


# Columns stored as TEXT but handed to the extension as a real list, so
# "select all that apply" can be matched element by element.
LIST_COLUMNS = {"skills", "languages"}


def _encode_column(name, value):
    """JSON-encode list columns; pass everything else through."""
    if value is None:
        return None
    if name in LIST_COLUMNS:
        if isinstance(value, str):
            items = [v.strip() for v in re.split(r"[,;\n|]", value) if v.strip()]
        elif isinstance(value, list):
            items = [str(v).strip() for v in value if str(v).strip()]
        else:
            items = [str(value).strip()]
        return json.dumps(items)
    return value


def _decode_row(row):
    """Turn a profile row into the JSON shape the extension expects."""
    if not row:
        return {}
    data = dict(row)
    for name in LIST_COLUMNS:
        raw = data.get(name)
        if isinstance(raw, str) and raw.strip():
            try:
                data[name] = json.loads(raw)
            except (ValueError, TypeError):
                data[name] = [v.strip() for v in re.split(r"[,;\n|]", raw) if v.strip()]
    return data

@app.get("/ping")
def ping():
    return {"status": "ok"}

@app.get("/profile")
def get_profile():
    try:
        with engine.connect() as conn:
            query = select(profile).where(profile.c.id == 1)
            result = conn.execute(query).mappings().first()
            return _decode_row(result)
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database query error: {str(e)}")

@app.post("/profile")
def upsert_profile(data: ProfileSchema):
    try:
        # exclude_unset keeps a partial save from blanking fields the user
        # never touched; extras are kept so nothing the UI sent is lost.
        values = data.model_dump(exclude_unset=True)
        if not values:
            return {"status": "noop", "data": {}}

        # Only write columns the table actually has.
        known = set(profile.c.keys())
        values = {k: v for k, v in values.items() if k in known}
        values = {k: _encode_column(k, v) for k, v in values.items()}

        with engine.connect() as conn:
            query = select(profile).where(profile.c.id == 1)
            exists = conn.execute(query).first()
            if exists:
                stmt = update(profile).where(profile.c.id == 1).values(**values)
                conn.execute(stmt)
                conn.commit()
                return {"status": "updated", "data": values}
            else:
                stmt = insert(profile).values(id=1, **values)
                conn.execute(stmt)
                conn.commit()
                return {"status": "created", "data": values}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database update error: {str(e)}")

@app.post("/resume/upload")
async def upload_resume(file: UploadFile = File(...)):
    filename = file.filename
    content = await file.read()
    
    raw_text = ""
    if filename.endswith(".pdf"):
        try:
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                pages_text = []
                for page in pdf.pages:
                    text = page.extract_text()
                    if text:
                        links = [h.get("uri") for h in page.hyperlinks if h.get("uri")]
                        if links:
                            text += "\nExtracted Links:\n" + "\n".join(links)
                        pages_text.append(text)
                raw_text = "\n".join(pages_text)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse PDF: {str(e)}")
            
    elif filename.endswith(".docx"):
        try:
            doc = docx.Document(io.BytesIO(content))
            pages_text = [p.text for p in doc.paragraphs]
            raw_text = "\n".join(pages_text)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse DOCX: {str(e)}")
    else:
        raise HTTPException(status_code=400, detail="Unsupported file format. Please upload a PDF or DOCX file.")
        
    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Could not extract any text from the resume.")

    # Call LLM to structure the resume ONLY if text was extracted
    system_prompt = """You are a precise resume parser. Extract the user's information from the provided resume text into a structured JSON object.
The JSON must have this exact structure:
{
  "profile_data": {
    "first_name": "str", "last_name": "str", "email": "str", "phone": "str",
    "dob": "str (YYYY-MM-DD if visible, else null)",
    "city": "str", "state": "str", "country": "str",
    "linkedin_url": "str", "github_url": "str", "portfolio_url": "str",
    "current_title": "str", "current_company": "str", "experience_years": "int",
    "total_experience_months": "int",
    "degree": "str", "branch": "str", "college_name": "str", "graduation_year": "str",
    "cgpa": "str (as written, e.g. '8.5/10')", "tenth_percent": "str", "twelfth_percent": "str",
    "skills": ["str"], "languages": ["str"],
    "marital_status": "str", "gender": "str"
  },
  "resume_sections": {
    "section_name": ["content"]
  }
}
Use null for anything not stated in the resume. Never invent a value.
Return ONLY valid JSON."""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Resume Text:\n{raw_text}"}
    ]
    
    try:
        llm_response = await call_openrouter(messages, response_format={"type": "json_object"})
        cleaned_json = llm_response.replace('```json', '').replace('```', '').strip()
        structured_data = json.loads(cleaned_json)
        profile_data = structured_data.get("profile_data", {})
        structured_json = json.dumps(structured_data.get("resume_sections", {}))
    except Exception as e:
        print(f"Warning: Failed to structure resume with LLM: {e}")
        profile_data = {}
        structured_json = None

    # Drop nulls and anything the table has no column for, then JSON-encode
    # the list columns so they survive the round-trip.
    profile_columns = set(profile.c.keys())
    profile_data = {
        k: _encode_column(k, v)
        for k, v in (profile_data or {}).items()
        if v not in (None, "", []) and k in profile_columns
    }

    try:
        with engine.connect() as conn:
            # Upsert Profile (backfill missing fields)
            if profile_data:
                q_prof = select(profile).where(profile.c.id == 1)
                existing_prof = conn.execute(q_prof).mappings().first()
                if existing_prof:
                    update_vals = {k: v for k, v in profile_data.items() if v and not existing_prof.get(k)}
                    if update_vals:
                        conn.execute(update(profile).where(profile.c.id == 1).values(**update_vals))
                else:
                    conn.execute(insert(profile).values(id=1, **{k: v for k, v in profile_data.items() if v}))

            query = select(resume).where(resume.c.id == 1)
            exists = conn.execute(query).first()
            
            if exists:
                stmt = update(resume).where(resume.c.id == 1).values(
                    filename=filename,
                    raw_text=raw_text,
                    structured_json=structured_json,
                    uploaded_at=datetime.datetime.now(datetime.timezone.utc)
                )
                conn.execute(stmt)
                conn.commit()
                status = "updated"
            else:
                stmt = insert(resume).values(
                    id=1,
                    filename=filename,
                    raw_text=raw_text,
                    structured_json=structured_json,
                    uploaded_at=datetime.datetime.now(datetime.timezone.utc)
                )
                conn.execute(stmt)
                conn.commit()
                status = "created"
        return {
            "status": status,
            "filename": filename,
            "structured": bool(structured_json)
        }
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database error during resume save: {str(e)}")

@app.get("/resume")
def get_resume():
    try:
        with engine.connect() as conn:
            query = select(resume).where(resume.c.id == 1)
            result = conn.execute(query).mappings().first()
            if result and result.get("structured_json"):
                return json.loads(result["structured_json"])
            return {}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database query error: {str(e)}")

class FieldToMatch(BaseModel):
    """One unresolved control, described well enough to pick an option."""
    label: str
    kind: Optional[str] = "text"
    options: List[str] = []


class MatchRequest(BaseModel):
    # Option-aware shape (current).
    fields: Optional[List[FieldToMatch]] = None
    # Legacy shape, still accepted so an older extension keeps working.
    unmatched_labels: Optional[List[str]] = None


CHOICE_KINDS = {"select", "multi-select", "radio", "checkbox-single", "checkbox-multi", "custom-dropdown"}

MATCH_SYSTEM_PROMPT = """You are an AI assistant helping to map ambiguous form controls to known data schemas.
The user has a profile schema with these keys: {profile_keys}
The user also has a structured resume with dynamically extracted keys (e.g., 'projects', 'education', 'skills', etc.).

For each form control, decide BOTH which data key answers it AND, when the control
offers a fixed set of options, which single option text should be chosen.

Return a JSON object mapping the EXACT form label to either:
  null
  "profile.<key>"
  "resume.<key>"
  {{"key": "profile.<key>", "choose": "<exact option text from the list>"}}

RULES:
1. If the control asks for information about ANOTHER PERSON (father, mother, spouse, guardian, emergency contact, reference, nominee), return null.
2. If it is a conversational question needing a custom written answer ("Why did your grades drop?"), return null.
3. If the data does not exist in the profile or resume (Aadhaar number, passport number, blood group), return null. Never force a mapping to an unrelated key.
4. WHEN OPTIONS ARE PROVIDED, you MUST pick one of those exact option strings. Never invent an option that is not in the list. Prefer the option that best expresses the user's actual data, even if the wording differs ("B.Tech" for a BTech degree, "2-3 years" for two years of experience, "Yes" for work authorisation).
5. For a question with options like "Other", "None of the above", or "Prefer not to say", only choose one of those when nothing else fits. Never choose "Other" if a specific listed option is correct.
6. If the same data is a list (skills, languages) and the control allows multiple selections, return the key with no "choose" — the client matches it against the list itself.

Return ONLY a JSON object.
Example:
{{"Preferred location": {{"key": "profile.preferred_location", "choose": "Bhopal"}},
  "Years of experience": {{"key": "profile.experience_years", "choose": "2-3 years"}},
  "Tell us about your projects": "resume.projects",
  "Father's Name": null,
  "Blood group": null}}
"""


def _coerce_field(item):
    """Accept either a plain label string or a FieldToMatch-shaped dict."""
    if isinstance(item, str):
        return {"label": item, "kind": "text", "options": []}
    if isinstance(item, dict):
        return {
            "label": str(item.get("label") or ""),
            "kind": item.get("kind") or "text",
            "options": [
                (o.get("text") if isinstance(o, dict) else str(o)) or ""
                for o in (item.get("options") or [])
            ],
        }
    return {"label": str(item), "kind": "text", "options": []}


@app.post("/match-field")
async def match_field(req: MatchRequest):
    raw_items = req.fields if req.fields else (req.unmatched_labels or [])
    fields = [_coerce_field(item) for item in raw_items]
    fields = [f for f in fields if f["label"]]
    if not fields:
        return {"mappings": {}}

    profile_keys = list(ProfileSchema.model_fields.keys())

    # Only choice controls need their options in the prompt; sending option
    # lists for text fields just burns tokens.
    payload = [
        {"label": f["label"], **({"kind": f["kind"], "options": f["options"][:30]} if f["options"] else {})}
        for f in fields
    ]

    system_prompt = MATCH_SYSTEM_PROMPT.format(profile_keys=profile_keys)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(payload)}
    ]

    try:
        llm_response = await call_openrouter(messages, response_format={"type": "json_object"})
        cleaned_json = llm_response.replace('```json', '').replace('```', '').strip()
        mappings = json.loads(cleaned_json)
        if not isinstance(mappings, dict):
            raise ValueError("Expected a JSON object of mappings")
        return {"mappings": mappings}
    except Exception as e:
        print(f"Error mapping fields: {e}")
        # Return explicit nulls so the extension still shows manual
        # sparkle assist instead of silently dropping the fields.
        return {"mappings": {f["label"]: None for f in fields}}

@app.post("/corrections")
def upsert_correction(data: CorrectionRequest):
    kind = data.field_kind if data.field_kind in ("value", "option") else "value"
    try:
        with engine.connect() as conn:
            query = select(corrections).where(corrections.c.field_label == data.field_label)
            exists = conn.execute(query).first()
            if exists:
                stmt = (
                    update(corrections)
                    .where(corrections.c.field_label == data.field_label)
                    .values(corrected_value=data.corrected_value, field_kind=kind)
                )
            else:
                stmt = insert(corrections).values(
                    field_label=data.field_label,
                    corrected_value=data.corrected_value,
                    field_kind=kind,
                )
            conn.execute(stmt)
            conn.commit()
            return {"status": "saved", "field_label": data.field_label, "corrected_value": data.corrected_value}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database update error: {str(e)}")

@app.get("/corrections")
def get_corrections():
    try:
        with engine.connect() as conn:
            query = select(corrections)
            result = conn.execute(query).mappings().all()
            return {r["field_label"]: r["corrected_value"] for r in result}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database query error: {str(e)}")

@app.put("/corrections")
def update_correction(data: CorrectionRequest):
    try:
        with engine.connect() as conn:
            stmt = update(corrections).where(corrections.c.field_label == data.field_label).values(corrected_value=data.corrected_value)
            result = conn.execute(stmt)
            conn.commit()
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="Correction not found")
            return {"status": "updated", "field_label": data.field_label, "corrected_value": data.corrected_value}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database update error: {str(e)}")

@app.delete("/corrections/{field_label:path}")
def delete_correction(field_label: str):
    try:
        with engine.connect() as conn:
            stmt = delete(corrections).where(corrections.c.field_label == field_label)
            result = conn.execute(stmt)
            conn.commit()
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="Correction not found")
            return {"status": "deleted", "field_label": field_label}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database delete error: {str(e)}")

@app.delete("/corrections")
def clear_all_corrections():
    try:
        with engine.connect() as conn:
            stmt = delete(corrections)
            result = conn.execute(stmt)
            conn.commit()
            return {"status": "cleared", "count": result.rowcount}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database clear error: {str(e)}")

class DraftRequest(BaseModel):
    questions: List[str]
    user_context: Optional[str] = None
    use_profile: bool = True

@app.post("/draft-answer")
async def draft_answer(req: DraftRequest):
    if not req.questions:
        return {"drafts": {}}

    context_str = ""
    if req.use_profile:
        profile_data = get_profile()
        resume_data = get_resume()
        context_str = f"User Profile Context:\n{json.dumps(profile_data, indent=2)}\n\nUser Resume Context:\n{json.dumps(resume_data, indent=2)}\n\n"

    if req.user_context:
        context_str += f"Additional User Instructions/Context:\n{req.user_context}\n\n"

    system_prompt = f"""You are a professional AI assistant helping a user fill out a job application, academic form, or registration form.
Your task is to draft a concise, professional answer for each specific question provided.
{context_str}
CRITICAL INSTRUCTIONS:
1. Write in a formal, professional tone in the first person ("I").
2. Keep answers concise (1-3 sentences) unless the user context specifies otherwise.
3. Only output a JSON object mapping the exact question string to your drafted answer string.
4. If the question asks for something you absolutely cannot guess and the user didn't provide context for (e.g., a specific ID number), output "Please answer this manually."

Return ONLY valid JSON.
Example: {{"Why did your grades go down?": "I was facing health issues during semester 4 which impacted my grades, but I recovered in the following semester."}}
"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(req.questions)}
    ]

    try:
        llm_response = await call_openrouter(messages, response_format={"type": "json_object"})
        cleaned_json = llm_response.replace('```json', '').replace('```', '').strip()
        drafts = json.loads(cleaned_json)
        return {"drafts": drafts}
    except Exception as e:
        print(f"Error drafting answers: {e}")
        return {"drafts": {q: "Error generating draft" for q in req.questions}}
