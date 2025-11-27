from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# --- Paths ---
THIS_DIR = Path(__file__).resolve().parent          # .../tests
PROJECT_ROOT = THIS_DIR.parent                      # .../ (project root)
BACKEND_DIR = PROJECT_ROOT / "backend"

# Load .env from project root so AWS_*, S3_BUCKET, etc. are visible
load_dotenv(PROJECT_ROOT / ".env")

# Import your existing S3 helpers
from backend.storage.s3_storage import (  # noqa: E402
    put_bytes,
    make_profile_key,
    get_bytes,
)


def main() -> None:
    profile_path = BACKEND_DIR / "data" / "profile.json"

    if not profile_path.exists():
        print(f"[test_s3] profile.json not found at: {profile_path}")
        return

    # Read local profile.json
    data = profile_path.read_bytes()

    # Use existing helper to decide the key (default: profiles/default.json)
    key = make_profile_key()

    bucket = os.getenv("S3_BUCKET")
    print(f"[test_s3] Uploading {profile_path} -> s3://{bucket}/{key}")

    # Upload to S3
    put_bytes(key, data, content_type="application/json; charset=utf-8")
    print("[test_s3] Upload completed without exception.")

    # Optional: read it back to confirm
    downloaded = get_bytes(key)
    print(f"[test_s3] Downloaded {len(downloaded)} bytes back from S3")


if __name__ == "__main__":
    main()
