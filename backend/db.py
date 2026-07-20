import datetime
from sqlalchemy import create_engine, MetaData, Table, Column, String, Integer, DateTime, Text

DATABASE_URL = "sqlite:///./formpilot.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
metadata = MetaData()

# Profile table (single-row setup; upserts will target id=1)
profile = Table(
    "profile",
    metadata,
    Column("id", Integer, primary_key=True, default=1),
    Column("first_name", String, nullable=True),
    Column("last_name", String, nullable=True),
    Column("email", String, nullable=True),
    Column("phone", String, nullable=True),
    Column("address_line1", String, nullable=True),
    Column("city", String, nullable=True),
    Column("state", String, nullable=True),
    Column("pincode", String, nullable=True),
    Column("country", String, nullable=True),
    Column("linkedin_url", String, nullable=True),
    Column("github_url", String, nullable=True),
    Column("portfolio_url", String, nullable=True),
    Column("current_title", String, nullable=True),
    Column("current_company", String, nullable=True),
    Column("experience_years", Integer, nullable=True),
    Column("work_authorization", String, nullable=True),
    Column("gender", String, nullable=True),
    Column("veteran_status", String, nullable=True),
    Column("disability_status", String, nullable=True),
)

# Resume table to store parsed text and filename
resume = Table(
    "resume",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("filename", String, nullable=True),
    Column("raw_text", Text, nullable=False),
    Column("structured_json", Text, nullable=True),
    Column("uploaded_at", DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc)),
)

# Corrections stub table (for future learning/refinement)
corrections = Table(
    "corrections",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("field_label", String, nullable=False),
    Column("corrected_value", String, nullable=False),
)

def init_db():
    metadata.create_all(engine)

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
