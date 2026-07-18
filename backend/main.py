import datetime
import io
from typing import Optional
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pdfplumber
import docx
from sqlalchemy import select, insert, update

from db import engine, profile, resume, init_db

app = FastAPI(title="FormPilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://nefbcnjmameakekdalabahboffpghejm"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    with engine.connect() as conn:
        query = select(profile).where(profile.c.id == 1)
        result = conn.execute(query).mappings().first()
        if result:
            return dict(result)
        return {}

@app.post("/profile")
def upsert_profile(data: ProfileSchema):
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

@app.post("/resume/upload")
def upload_resume(file: UploadFile = File(...)):
    filename = file.filename
    content = file.file.read()
    
    raw_text = ""
    if filename.endswith(".pdf"):
        try:
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                pages_text = []
                for page in pdf.pages:
                    text = page.extract_text()
                    if text:
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

    with engine.connect() as conn:
        query = select(resume).where(resume.c.id == 1)
        exists = conn.execute(query).first()
        
        if exists:
            stmt = update(resume).where(resume.c.id == 1).values(
                filename=filename,
                raw_text=raw_text,
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
                uploaded_at=datetime.datetime.now(datetime.timezone.utc)
            )
            conn.execute(stmt)
            conn.commit()
            status = "created"
            
    return {
        "status": status,
        "filename": filename,
        "raw_text_preview": raw_text[:200] + "..." if len(raw_text) > 200 else raw_text
    }
