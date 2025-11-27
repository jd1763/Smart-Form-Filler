"""
Lightweight S3 helper used by the Flask API.

Why a separate module?
- keeps boto3 code isolated and easy to test
- lets api.py stay focused on HTTP and business logic
- supports future swap (e.g., MinIO, GCS) by changing only this file
"""

from __future__ import annotations

import json
import os
from typing import Optional

import boto3
from botocore.config import Config

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET = os.getenv("S3_BUCKET")  # required when USE_S3=true

# Configure retries; S3 is "eventually consistent" and network-bound
_BOTO_CFG = Config(retries={"max_attempts": 10, "mode": "standard"})
_s3 = boto3.client("s3", region_name=AWS_REGION, config=_BOTO_CFG)

_S3 = boto3.client("s3", region_name=os.getenv("AWS_REGION"))
_BUCKET = os.getenv("S3_BUCKET")

def _bucket() -> str:
    """
    Return the current S3 bucket name from the environment.

    We resolve this at call-time instead of import-time so .env
    (load_dotenv) has already run when api.py imports this module.
    """
    bucket = os.getenv("S3_BUCKET")
    if not bucket:
        raise RuntimeError("S3_BUCKET environment variable is not set")
    return bucket

def make_resume_key(resume_id: str, original_filename: str) -> str:
    """
    Build a deterministic object key for a given resume id.
    Example: resumes/123e4567-e89b-12d3-a456-426614174000.pdf
    """
    # Preserve the extension if possible; default to .bin
    ext = ""
    if "." in original_filename:
        ext = "." + original_filename.rsplit(".", 1)[1].lower()
    if ext not in (".pdf", ".docx", ".txt"):
        # .txt only for extracted text if you later decide to push those too
        ext = ".bin"
    return f"resumes/{resume_id}{ext}"


def make_text_key(resume_id: str) -> str:
    """
    S3 object key for extracted plain text of a resume.
    Stored as UTF-8 .txt for portability.
    Example: texts/123e4567-e89b-12d3-a456-426614174000.txt
    """
    return f"texts/{resume_id}.txt"


def put_bytes(key: str, data: bytes, content_type: Optional[str] = None) -> None:
    """
    Upload raw bytes to S3 at the provided key.
    We enable SSE-S3 by default for at-rest encryption.
    """
    extra = {}
    if content_type:
        extra["ContentType"] = content_type

    _s3.put_object(
        Bucket=_bucket(),
        Key=key,
        Body=data,
        ServerSideEncryption="AES256",
        **extra,
    )


def get_bytes(key: str) -> bytes:
    """Download raw bytes for a given key."""
    obj = _s3.get_object(Bucket=_bucket(), Key=key)
    return obj["Body"].read()


def delete_object(key: str) -> None:
    """Delete a single object; no error if the object did not exist."""
    _s3.delete_object(Bucket=_bucket(), Key=key)


def presign_get(key: str, expires_seconds: int = 300) -> str:
    """
    Create a short-lived URL for direct browser downloads.
    Prefer using the Flask /resumes/<id>/file proxy to avoid CORS issues
    from Chrome extensions; keep this for admin tools or future UI.
    """
    return _s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": _bucket(), "Key": key},
        ExpiresIn=expires_seconds,
    )


def make_profile_key(object_key=None):
    """Return the S3 key for the profile.json object."""
    return object_key or os.getenv("PROFILE_OBJECT_KEY", "profiles/default.json")


# --- JSON convenience ---
def put_json(key: str, obj: dict):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    put_bytes(key, data, "application/json; charset=utf-8")


def get_json(key: str) -> dict:
    try:
        raw = get_bytes(key)
        return json.loads(raw.decode("utf-8"))
    except _s3.exceptions.NoSuchKey:
        return {}