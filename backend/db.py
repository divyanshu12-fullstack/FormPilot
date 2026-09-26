import datetime
import os

from sqlalchemy import create_engine, MetaData, Table, Column, String, Integer, DateTime, Text, inspect, text
from sqlalchemy.exc import SQLAlchemyError

# Anchor the database to THIS file's folder, not the current working directory.
# A relative "sqlite:///./formpilot.db" silently creates a second, empty
# database whenever the server is started from anywhere other than backend/,
# which looks exactly like "my data disappeared".
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BACKEND_DIR, "formpilot.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

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
    # ── Added for choice controls (radio / checkbox / dropdown / calendar) ──
    # These are the fields people are repeatedly asked for on placement and
    # hackathon forms but which had nowhere to live in the schema.
    Column("dob", String, nullable=True),                    # ISO YYYY-MM-DD
    Column("cgpa", String, nullable=True),                  # e.g. "9.01/10.00"
    Column("degree", String, nullable=True),                # B.Tech / MBA / ...
    Column("branch", String, nullable=True),                # Computer Science, ...
    Column("college_name", String, nullable=True),
    Column("graduation_year", String, nullable=True),
    Column("tenth_percent", String, nullable=True),
    Column("twelfth_percent", String, nullable=True),
    Column("skills", Text, nullable=True),                  # JSON array
    Column("languages", Text, nullable=True),               # JSON array
    Column("notice_period_days", Integer, nullable=True),
    Column("preferred_location", String, nullable=True),
    Column("relocation_ok", String, nullable=True),
    Column("remote_work_ok", String, nullable=True),
    Column("total_experience_months", Integer, nullable=True),
    Column("marital_status", String, nullable=True),
    Column("blood_group", String, nullable=True),
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
    # 'value' (plain text) or 'option' (a choice label picked from a radio /
    # checkbox / dropdown). Keeping them apart stops a consent-box correction
    # from ever being replayed onto a data field.
    Column("field_kind", String, nullable=False, server_default="value"),
)

# Columns added after v1. create_all() only issues CREATE TABLE, so an
# existing formpilot.db needs explicit ALTER TABLE statements.
_ADDITIVE_MIGRATIONS = {
    "profile": [
        ("dob", "VARCHAR"),
        ("cgpa", "VARCHAR"),
        ("degree", "VARCHAR"),
        ("branch", "VARCHAR"),
        ("college_name", "VARCHAR"),
        ("graduation_year", "VARCHAR"),
        ("tenth_percent", "VARCHAR"),
        ("twelfth_percent", "VARCHAR"),
        ("skills", "TEXT"),
        ("languages", "TEXT"),
        ("notice_period_days", "INTEGER"),
        ("preferred_location", "VARCHAR"),
        ("relocation_ok", "VARCHAR"),
        ("remote_work_ok", "VARCHAR"),
        ("total_experience_months", "INTEGER"),
        ("marital_status", "VARCHAR"),
        ("blood_group", "VARCHAR"),
    ],
    "corrections": [
        ("field_kind", "VARCHAR NOT NULL DEFAULT 'value'"),
    ],
}


def migrate():
    """Add any columns a pre-existing database is missing.

    create_all() is CREATE-only and will happily skip tables that already
    exist, so without this an upgraded extension would crash on insert with
    "no such column: profile.cgpa".
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for table_name, columns in _ADDITIVE_MIGRATIONS.items():
        if table_name not in existing_tables:
            continue  # create_all() will make it with the full shape
        present = {c["name"] for c in inspector.get_columns(table_name)}
        for column_name, sql_type in columns:
            if column_name in present:
                continue
            ddl = f"ALTER TABLE {table_name} ADD COLUMN {column_name} {sql_type}"
            with engine.begin() as conn:
                conn.execute(text(ddl))
            print(f"Migration: added {table_name}.{column_name}")


def init_db():
    metadata.create_all(engine)
    try:
        migrate()
    except SQLAlchemyError as e:
        # A failed migration must not stop the server from booting — the
        # existing columns still work, the new ones just stay unavailable.
        print(f"Warning: migration skipped ({e})")


if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
