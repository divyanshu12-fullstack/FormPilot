import datetime
import io
import os
import httpx
import json
from typing import Optional, List
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pdfplumber
import docx
from sqlalchemy import select, insert, update
from sqlalchemy.exc import SQLAlchemyError
from dotenv import load_dotenv

load_dotenv()
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openrouter/free")

from db import engine, profile, resume, corrections, init_db

class CorrectionRequest(BaseModel):
    field_label: str
    corrected_value: str

app = FastAPI(title="FormPilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://nefbcnjmameakekdalabahboffpghejm"],
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

@app.on_event("startup")
def startup_event():
    init_db()

@app.get("/ping")
def ping():
    return {"status": "ok"}

@app.get("/profile")
def get_profile():
    try:
        with engine.connect() as conn:
            query = select(profile).where(profile.c.id == 1)
            result = conn.execute(query).mappings().first()
            if result:
                return dict(result)
            return {}
    except SQLAlchemyError as e:
        raise HTTPException(status_code=500, detail=f"Database query error: {str(e)}")

@app.post("/profile")
def upsert_profile(data: ProfileSchema):
    try:
        with engine.connect() as conn:
            query = select(profile).where(profile.c.id == 1)
            exists = conn.execute(query).first()
            
            values = data.model_dump()
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
    "city": "str", "state": "str", "country": "str",
    "linkedin_url": "str", "github_url": "str", "portfolio_url": "str",
    "current_title": "str", "current_company": "str", "experience_years": "int"
  },
  "resume_sections": {
    "section_name": ["content"]
  }
}
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

class MatchRequest(BaseModel):
    unmatched_labels: List[str]

@app.post("/match-field")
async def match_field(req: MatchRequest):
    if not req.unmatched_labels:
        return {"mappings": {}}
        
    profile_keys = list(ProfileSchema.model_fields.keys())
    
    system_prompt = f"""You are an AI assistant helping to map ambiguous form labels to known data schemas.
The user has a profile schema with these keys: {profile_keys}
The user also has a structured resume with dynamically extracted keys (e.g., 'projects', 'education', 'skills', etc.).

For each form label provided, map it to the MOST appropriate key. 
If it maps to a profile key, use the format 'profile.<key>'.
If it requires a long-form answer from a resume section, use 'resume.<key>'.

CRITICAL INSTRUCTION: If the form label is a conversational question (e.g., 'Why did your grades go down?', 'What is your motivation?') that requires a custom written answer rather than a direct copy-paste of a resume section, YOU MUST MAP IT TO null. Do not attempt to map conversational questions to static resume sections. Only map fields that are clearly asking for existing data.

Return ONLY a JSON object mapping the exact form labels to the keys.
Example: {{"What is your primary phone?": "profile.phone", "Tell us about your past projects": "resume.projects", "Why did you choose this major?": null}}
"""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(req.unmatched_labels)}
    ]
    
    try:
        llm_response = await call_openrouter(messages, response_format={"type": "json_object"})
        cleaned_json = llm_response.replace('```json', '').replace('```', '').strip()
        mappings = json.loads(cleaned_json)
        return {"mappings": mappings}
    except Exception as e:
        print(f"Error mapping fields: {e}")
        return {"mappings": {}}

@app.post("/corrections")
def upsert_correction(data: CorrectionRequest):
    try:
        with engine.connect() as conn:
            query = select(corrections).where(corrections.c.field_label == data.field_label)
            exists = conn.execute(query).first()
            if exists:
                stmt = update(corrections).where(corrections.c.field_label == data.field_label).values(corrected_value=data.corrected_value)
            else:
                stmt = insert(corrections).values(field_label=data.field_label, corrected_value=data.corrected_value)
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
