"""
Migrate existing local resume files into S3 and rewrite DB rows to s3://.
Run from repo root:  python scripts/migrate_local_resumes_to_s3.py
"""

from __future__ import annotations

import mimetypes
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from storage.s3_storage import make_resume_key, put_bytes  # keep this import

# Make backend/ importable so we can do `from storage.s3_storage ...`
BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.append(str(BACKEND_DIR))

# Reuse settings from backend/api.py file layout
BASE_DIR = BACKEND_DIR
DB_PATH = BASE_DIR / "db.sqlite3"
PDF_DIR = BASE_DIR / "data" / "resumes"


def run():
    # Load .env so S3_BUCKET is available
    load_dotenv()

    engine = create_engine(f"sqlite:///{DB_PATH}", future=True)
    # Basic existence checks
    if not PDF_DIR.exists():
        print(f"No local resumes dir found at {PDF_DIR}. Nothing to migrate.")
        return

    with engine.begin() as conn:
        rows = list(
            conn.execute(text("SELECT id, original_name, mime_type, pdf_path FROM resumes"))
        )
        for rid, original_name, mime_type, pdf_path in rows:
            # skip already migrated
            if isinstance(pdf_path, str) and pdf_path.startswith("s3://"):
                print(f"skip {rid} (already on S3)")
                continue

            # locate the file on disk
            # Try recorded path first, then fallback to by-id.*
            path = Path(pdf_path) if pdf_path else None
            if not path or not path.exists():
                hits = list(PDF_DIR.glob(f"{rid}.*"))
                path = hits[0] if hits else None

            if not path or not path.exists():
                print(f"missing file for {rid} -> {pdf_path}")
                continue

            mt = mime_type or (mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            key = make_resume_key(rid, original_name or path.name)
            data = path.read_bytes()
            put_bytes(key, data, content_type=mt)

            # Update DB to point at s3://
            s3_url = f"s3://{os.getenv('S3_BUCKET')}/{key}"
            conn.execute(
                text("UPDATE resumes SET pdf_path=:p WHERE id=:id"), {"p": s3_url, "id": rid}
            )
            # Remove local file
            try:
                path.unlink()
            except Exception:
                pass
            print(f"migrated {rid} -> {s3_url}")

    print("done.")


if __name__ == "__main__":
    run()
