"""
My Flask API for Smart Form Filler
----------------------------------

This file runs a small web server that my Chrome extension will talk to.
It loads my trained ML model (`form_model.pkl`) and gives predictions
about what kind of form field a label is (ex: email, name, phone).

The extension sends a label -> this API sends back prediction + confidence.
"""

import datetime as dt
import glob
import io  # for streaming S3 bytes back to the browser
import json
import mimetypes
import os
import random
import re
import socket
import sys  # helps build file paths
import uuid
import joblib  # used to load my saved ML model
from docx import Document
from pathlib import Path
from dotenv import load_dotenv

# Load .env early so S3/boto3 see AWS_* variables before we import s3_storage
load_dotenv()

# Flask basics for building APIs
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS  # lets my Chrome extension call this API without CORS errors

# --------- Text extractors ----------
from pdfminer.high_level import extract_text as pdf_extract_text
from sqlalchemy import Column, DateTime, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from werkzeug.exceptions import HTTPException

# === Import matchers ===
# - BaselineMatcher: TF-IDF + cosine similarity
# - MatcherEmbeddings: Sentence-BERT embeddings + semantic similarity
from ml.matcher_baseline import BaselineMatcher
from ml.matcher_embeddings import MatcherEmbeddings

from .matcher.resume_selector import select_best_resume
from .storage.s3_storage import delete_object, get_bytes, put_bytes

# Add the project root to Python path so we can import ml/ and backend/ modules
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

def detect_mime(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    return mt or "application/octet-stream"


def extract_text_any(path: str) -> str:
    mime = detect_mime(path)
    if mime == "application/pdf":
        return pdf_extract_text(path) or ""
    if mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        doc = Document(path)
        return "\n".join(p.text for p in doc.paragraphs)
    raise ValueError(f"Unsupported file type: {mime}")


# === Path to the model file ===
# I keep my trained scikit-learn model in /models/form_model.pkl
# This builds a path that works no matter where the file is run from.
MODEL_PATH = os.path.join(
    os.path.dirname(__file__),  # start from backend/ folder
    "..",  # go up to project root
    "models",  # into models/ folder
    "form_model.pkl",  # the actual pickle file
)

# --------- App / DB setup ----------
BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT_NAME = os.getenv("SFF_STORAGE_DIR", "data")  # you renamed to "data"
STORAGE_DIR = BASE_DIR / STORAGE_ROOT_NAME
LEGACY_DIR = BASE_DIR / "uploads"  # keep compatibility with old uploads/

PDF_DIR = STORAGE_DIR / "resumes"
TEXT_DIR = STORAGE_DIR / "text"
for p in (STORAGE_DIR, PDF_DIR, TEXT_DIR):
    p.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR = STORAGE_DIR
DB_PATH = BASE_DIR / "db.sqlite3"
PROFILE_PATH = UPLOADS_DIR / "profile.json"
MAX_RESUMES = 5

# --- S3 feature flags (local/dev still works if these are unset) ---
USE_S3 = os.getenv("USE_S3", "false").lower() == "true"
USE_S3_TEXT = os.getenv("USE_S3_TEXT", "false").lower() == "true"
USE_S3_PROFILE = os.getenv("USE_S3_PROFILE", "false").lower() == "true"
KEEP_LOCAL_TEXT_CACHE = os.getenv("KEEP_LOCAL_TEXT_CACHE", "false").lower() == "true"
S3_BUCKET = os.getenv("S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")

# Default user id if the caller doesn’t pass one (good for local/dev)
DEFAULT_USER = os.getenv("DEFAULT_USER", "default")

print(
    "[api] S3 config:",
    "USE_S3=", USE_S3,
    "USE_S3_TEXT=", USE_S3_TEXT,
    "USE_S3_PROFILE=", USE_S3_PROFILE,
    "KEEP_LOCAL_TEXT_CACHE=", KEEP_LOCAL_TEXT_CACHE,
    "S3_BUCKET=", S3_BUCKET,
    "AWS_REGION=", AWS_REGION,
)

def _user_id_from_request() -> str:
    """
    Read the "userId" from querystring, form-data, or header (X-User-Id).
    Falls back to DEFAULT_USER for dev.
    """
    return (
        request.args.get("userId")
        or request.form.get("userId")
        or request.headers.get("X-User-Id")
        or DEFAULT_USER
    )


def _is_s3_url(p) -> bool:
    return isinstance(p, str) and p.startswith("s3://")


def _split_s3_url(url: str) -> tuple[str, str]:
    """Split 's3://bucket/key' -> (bucket, key)."""
    tail = url[len("s3://"):]
    bucket, _, key = tail.partition("/")
    return bucket, key


# --- Per-user S3 keys (keeps data separated by user) ---
def _s3_key_pdf(user_id: str, rid: str, original_filename: str) -> str:
    ext = os.path.splitext(original_filename)[1].lower()
    if ext not in (".pdf", ".docx"):
        ext = ".bin"
    return f"users/{user_id}/resumes/{rid}{ext}"


def _s3_key_text(user_id: str, rid: str) -> str:
    return f"users/{user_id}/texts/{rid}.txt"


def _s3_key_profile(user_id: str) -> str:
    return f"users/{user_id}/profile.json"


def _read_text_any(path_str: str) -> str:
    """Return text whether stored locally or at s3://..."""
    if _is_s3_url(path_str):
        _, key = _split_s3_url(path_str)
        return get_bytes(key).decode("utf-8", errors="replace")
    with open(path_str, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


# === Set up Flask app ===
app = Flask(__name__)
CORS(app)  # allow cross-origin requests (needed for Chrome extension -> API calls)

# --- Global error handlers (always return JSON) ---


@app.errorhandler(HTTPException)
def handle_http_exception(e: HTTPException):
    """
    Convert all Werkzeug/Flask HTTPExceptions (abort(404), etc.)
    into a consistent JSON shape so the popup can inspect error.code.
    """
    response = jsonify(
        {
            "error": e.description or str(e),
            "code": e.code,
            "type": e.name,
        }
    )
    return response, e.code


@app.errorhandler(Exception)
def handle_unexpected_exception(e: Exception):
    """
    Catch-all for any unhandled exception and return JSON 500.
    This prevents HTML error pages from confusing the extension.
    """
    # Log full traceback to the server console for debugging
    import traceback

    traceback.print_exc()

    response = jsonify(
        {
            "error": "Internal server error",
            "code": 500,
            "details": str(e),
        }
    )
    return response, 500


engine = create_engine(f"sqlite:///{DB_PATH}", future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

# === Load model once when the server starts ===
try:
    model = joblib.load(MODEL_PATH)
    print(f"=== Loaded model from {MODEL_PATH} ===")
except Exception as e:
    raise RuntimeError(f"=== Could not load model from {MODEL_PATH}: {e} ===")

# === Instantiate matchers ===
tfidf_matcher = BaselineMatcher()  # baseline TF-IDF matcher
try:
    embedding_matcher = MatcherEmbeddings()  # try to load embedding model
except Exception as e:
    # If embeddings fail to load (e.g. no GPU, missing package), fall back to TF-IDF only
    embedding_matcher = None
    print(f"[WARNING] Could not load embeddings matcher: {e}")


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(String, primary_key=True)  # uuid
    original_name = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    pdf_path = Column(String, nullable=False)  # original file path (pdf or docx)
    text_path = Column(String, nullable=False)  # extracted .txt path
    size_bytes = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=dt.datetime.utcnow)


Base.metadata.create_all(engine)


# I keep the skill terms in a plain .txt so I can update without touching code.
def load_skill_terms() -> list[str]:
    # default location sits right next to the DB/data we already track
    default_path = Path(__file__).resolve().parent / "skill_terms.txt"
    terms_file = Path(os.getenv("SKILL_TERMS_FILE", str(default_path)))

    seen = set()
    terms: list[str] = []

    if not terms_file.exists():
        print(f"[api] heads up: {terms_file} not found; using empty list")
        return terms

    # I accept comments (#) and blank lines; everything else becomes a lowercase term.
    for raw in terms_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        term = line.lower()
        if term not in seen:
            seen.add(term)
            terms.append(term)

    print(f"[api] loaded {len(terms)} skill terms from {terms_file}")
    return terms


# loading once at import-time is perfect for my use-case
SKILL_TERMS = load_skill_terms()


# --- Helpers for /skills/by_resume ---
def get_resume_text_by_id(rid: str) -> str:
    """
    Return extracted text for resume <rid>, preferring backend/data/text/<id>.txt.
    If missing, try to repair via ensure_text_exists(...), otherwise extract from PDF
    in backend/data/resumes and persist to backend/data/text.
    """
    try:
        with SessionLocal() as s:
            r = s.get(Resume, str(rid))
            if not r:
                return ""

            # 1) Try DB path if present
            if getattr(r, "text_path", None):
                p = Path(r.text_path)
                if p.exists():
                    return p.read_text(encoding="utf-8")

            # 2) Canonical text location by ID
            txt_path = TEXT_DIR / f"{r.id}.txt"
            if txt_path.exists():
                # (optional) backfill DB
                try:
                    r.text_path = str(txt_path)
                    s.add(r)
                    s.commit()
                except Exception:
                    pass
                return txt_path.read_text(encoding="utf-8")

            # 3) If you have an existing helper, let it (re)create the text file
            try:
                # ensure_text_exists should return a Path or str to the text file
                out = ensure_text_exists(s, r)  # <-- use your existing function if present
                out_p = Path(out)
                if out_p.exists():
                    return out_p.read_text(encoding="utf-8")
            except Exception:
                pass

            # 4) Last resort: extract from PDF and persist
            pdf_candidates = []
            if getattr(r, "pdf_path", None):
                pdf_candidates.append(Path(r.pdf_path))
            pdf_candidates.append(PDF_DIR / f"{r.id}.pdf")

            text = ""
            for pdf in pdf_candidates:
                try:
                    if pdf and pdf.exists():
                        text = extract_text_any(str(pdf)) or ""  # use your existing extractor
                        if text:
                            break
                except Exception:
                    continue

            if text:
                try:
                    TEXT_DIR.mkdir(parents=True, exist_ok=True)
                    txt_path.write_text(text, encoding="utf-8")
                    # backfill DB for next time
                    try:
                        r.text_path = str(txt_path)
                        s.add(r)
                        s.commit()
                    except Exception:
                        pass
                except Exception:
                    pass
            return text
    except Exception:
        return ""


def get_resume_name_by_id(rid: str) -> str:
    """Human-readable file name for the resume from DB (fallback empty)."""
    try:
        with SessionLocal() as s:
            r = s.get(Resume, str(rid))
            return getattr(r, "original_name", "") or getattr(r, "file_name", "") or ""
    except Exception:
        return ""


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


def extract_skills_from_text(text: str):
    t = _normalize(text)
    hits = set()
    multi = [s for s in SKILL_TERMS if " " in s]
    single = [s for s in SKILL_TERMS if " " not in s]
    # exact substring for multi-word
    for m in multi:
        if m in t:
            hits.add(m)
    # token presence for single words
    tokens = set(re.split(r"[^a-z0-9\+#\.]+", t))
    for s in single:
        if s in tokens:
            hits.add(s)
    return sorted(hits)


def _find_pdf_for_id(rid: str):
    # Look in current root
    hits = glob.glob(str(PDF_DIR / f"{rid}.*"))
    if hits:
        return hits[0]
    # Look in legacy root
    hits = glob.glob(str(LEGACY_DIR / "resumes" / f"{rid}.*"))
    return hits[0] if hits else None


def _text_path_for_id(rid: str):
    return TEXT_DIR / f"{rid}.txt"


def ensure_text_exists(session, rec: Resume) -> str:
    """Return a valid text_path for this resume, repairing/migrating if needed."""
    # 1) if DB path exists, use it
    if rec.text_path and os.path.exists(rec.text_path):
        return rec.text_path

    # 2) if text exists in the new location, update DB
    new_txt = _text_path_for_id(rec.id)
    if new_txt.exists():
        rec.text_path = str(new_txt)
        session.add(rec)
        session.commit()
        return rec.text_path

    # 3) if we have the PDF/DOCX anywhere, re-extract and update DB
    pdf_path = (
        rec.pdf_path
        if (rec.pdf_path and os.path.exists(rec.pdf_path))
        else _find_pdf_for_id(rec.id)
    )
    if pdf_path and os.path.exists(pdf_path):
        try:
            txt = extract_text_any(pdf_path)
            new_txt.parent.mkdir(parents=True, exist_ok=True)
            with open(new_txt, "w", encoding="utf-8") as f:
                f.write(txt or "")
            rec.text_path = str(new_txt)
            # also repair pdf_path if it was in legacy location
            if rec.pdf_path != pdf_path:
                rec.pdf_path = str(pdf_path)
                rec.size_bytes = os.path.getsize(pdf_path)
            session.add(rec)
            session.commit()
            return rec.text_path
        except Exception as e:
            raise RuntimeError(f"Re-extract failed for {rec.id}: {e}")

    # 4) last resort: not recoverable
    raise FileNotFoundError(f"No text or PDF found for resume {rec.id}")


def to_dict(r: Resume):
    return {
        "id": r.id,
        "original_name": r.original_name,
        "mime_type": r.mime_type,
        "size_bytes": r.size_bytes,
        "created_at": r.created_at.isoformat() + "Z",
    }


def count_resumes(session):
    return session.query(Resume).count()


# --- Deep merge ---
def deep_merge(a: dict, b: dict) -> dict:
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep_merge(a[k], v)
        else:
            a[k] = v
    return a


@app.get("/debug/skills")
def debug_skills():
    # sanity check endpoint so I can see first 20 terms without digging logs
    return {"count": len(SKILL_TERMS), "sample": SKILL_TERMS[:20]}


@app.post("/skills/extract")
def skills_extract():
    """
    POST { "text": "<resume plain text>" } -> { "skills": [...] }
    Must return 200 even for empty text (tests expect that).
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text", "") or ""
    skills = extract_skills_from_text(text)
    return jsonify({"skills": skills}), 200


@app.post("/skills/by_resume")
def skills_by_resume():
    """
    POST { "resumeId": "<id>" } -> { "id": "<id>", "name": "<name>", "skills": [...] }
    In production we load from DB/S3; tests can monkeypatch helpers.
    """
    data = request.get_json(silent=True) or {}
    rid = data.get("resumeId")
    if not rid:
        return jsonify({"error": "resumeId required"}), 400

    text = ""
    name = ""

    # 1) Try monkeypatched helpers first (pytest may define these on this module).
    try:
        text = get_resume_text_by_id(rid)  # provided by tests via monkeypatch
    except NameError:
        text = ""

    try:
        name = get_resume_name_by_id(rid)  # provided by tests via monkeypatch
    except NameError:
        name = ""

    # 2) Fallback to DB / S3 if text or name is still missing
    if not text or not text.strip() or not name:
        with SessionLocal() as s:
            r = s.get(Resume, rid)
            if not r:
                return jsonify({"error": "Resume not found"}), 404

            # Fill in missing name
            if not name:
                name = r.original_name or rid

            # Fill in missing text
            if not text or not text.strip():
                text_path = r.text_path
                # If no text_path yet, try to repair/generate locally
                if not text_path or (not _is_s3_url(text_path) and not os.path.exists(text_path)):
                    try:
                        text_path = ensure_text_exists(s, r)
                    except FileNotFoundError as e:
                        return jsonify({"error": str(e)}), 404
                    except Exception as e:
                        return jsonify({"error": f"Failed to load resume text: {e}"}), 500

                # Read from S3 or local
                text = _read_text_any(text_path)

    skills = extract_skills_from_text(text or "")
    return jsonify({"id": rid, "name": name, "skills": skills}), 200


@app.get("/profile")
def get_profile():
    user_id = _user_id_from_request()
    if USE_S3_PROFILE and S3_BUCKET:
        try:
            key = _s3_key_profile(user_id)
            data = get_bytes(key)
            return jsonify(json.loads(data.decode("utf-8"))), 200
        except Exception:
            # If profile doesn’t exist yet in S3, return empty object
            return jsonify({}), 200

    # Local fallback (single shared file for dev)
    if not PROFILE_PATH.exists():
        return jsonify({})
    with open(PROFILE_PATH, "r", encoding="utf-8") as f:
        return jsonify(json.load(f) or {})


@app.post("/profile")
@app.put("/profile")
def put_profile():
    try:
        data = request.get_json(force=True, silent=False) or {}
    except Exception as e:
        return jsonify({"error": f"Invalid JSON: {e}"}), 400

    user_id = _user_id_from_request()
    if USE_S3_PROFILE and S3_BUCKET:
        try:
            key = _s3_key_profile(user_id)
            put_bytes(
                key,
                json.dumps(data, ensure_ascii=False).encode("utf-8"),
                content_type="application/json; charset=utf-8",
            )
            return jsonify({"ok": True, "updated_at": dt.datetime.utcnow().isoformat() + "Z"})
        except Exception as e:
            return jsonify({"error": f"Failed to write profile to S3: {e}"}), 500

    # Local fallback
    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "updated_at": dt.datetime.utcnow().isoformat() + "Z"})
    except Exception as e:
        return jsonify({"error": f"Failed to write profile: {e}"}), 500


@app.route("/profile", methods=["PATCH"])
def patch_profile():
    # 1) parse patch body
    try:
        patch = request.get_json(force=True, silent=True) or {}
    except Exception as e:
        return jsonify({"error": f"Bad JSON: {e}"}), 400

    user_id = _user_id_from_request()

    # 2) read current profile
    existing = {}
    if USE_S3_PROFILE and S3_BUCKET:
        try:
            key = _s3_key_profile(user_id)
            existing = json.loads(get_bytes(key).decode("utf-8")) or {}
        except Exception:
            existing = {}
    else:
        try:
            if PROFILE_PATH.exists():
                with open(PROFILE_PATH, "r", encoding="utf-8") as f:
                    existing = json.load(f) or {}
        except Exception as e:
            return jsonify({"error": f"Failed to read profile: {e}"}), 500

    # 3) deep-merge + write
    merged = deep_merge(existing, patch)
    if USE_S3_PROFILE and S3_BUCKET:
        try:
            key = _s3_key_profile(user_id)
            put_bytes(
                key,
                json.dumps(merged, ensure_ascii=False).encode("utf-8"),
                content_type="application/json; charset=utf-8",
            )
            return jsonify(merged)
        except Exception as e:
            return jsonify({"error": f"Failed to write profile to S3: {e}"}), 500

    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return jsonify({"error": f"Failed to write profile: {e}"}), 500

    return jsonify(merged)


# --------- List ----------
@app.get("/resumes")
def list_resumes():
    """
    Return all resumes in newest-first order.

    Success:
        200 { "items": [...], "max": <MAX_RESUMES> }

    Failure:
        500 { "error": "...", "code": 500 }
    """
    try:
        with SessionLocal() as s:
            items = [to_dict(r) for r in s.query(Resume).order_by(Resume.created_at.desc()).all()]
        return jsonify({"items": items, "max": MAX_RESUMES}), 200
    except Exception as e:
        return (
            jsonify({"error": f"Failed to list resumes: {e}", "code": 500}),
            500,
        )


# --------- Upload ----------
@app.post("/resumes")
def upload_resume():
    # Enforce limit
    with SessionLocal() as s:
        if count_resumes(s) >= MAX_RESUMES:
            return (
                jsonify(
                    {
                        "error": (
                            f"Maximum of {MAX_RESUMES} resumes reached. "
                            "Delete one to upload another."
                        )
                    }
                ),
                400,
            )

    if "file" not in request.files:
        return jsonify({"error": "No file provided; expected form-data 'file'."}), 400
    f = request.files["file"]
    if not f or not f.filename:
        return jsonify({"error": "Empty file."}), 400

    # temp save to determine type
    tmp_id = str(uuid.uuid4())
    orig_ext = os.path.splitext(f.filename)[1].lower()
    tmp_path = PDF_DIR / f"{tmp_id}{orig_ext or ''}"
    f.save(tmp_path)

    try:
        # Prefer browser MIME, fall back to filename-based guess
        mime = f.mimetype or detect_mime(f.filename) or detect_mime(str(tmp_path))
        if mime not in (
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ):
            os.remove(tmp_path)
            return jsonify({"error": "Only PDF and DOCX are supported."}), 400

        # finalize name with extension
        if orig_ext not in [".pdf", ".docx"]:
            orig_ext = ".pdf" if mime == "application/pdf" else ".docx"

        rid = str(uuid.uuid4())
        final_pdf_path = PDF_DIR / f"{rid}{orig_ext}"
        os.rename(tmp_path, final_pdf_path)

        file_size = os.path.getsize(final_pdf_path)

        # extract text to .txt
        text_out = extract_text_any(str(final_pdf_path))
        text_path = TEXT_DIR / f"{rid}.txt"
        with open(text_path, "w", encoding="utf-8") as out:
            out.write(text_out)

        user_id = _user_id_from_request()

        # These will be set in either S3 or local branch
        pdf_path_db: str
        text_path_db: str

        if USE_S3 and S3_BUCKET:
            print(f"[upload_resume] S3 mode: bucket={S3_BUCKET}, user_id={user_id}, rid={rid}")
            try:
                # Upload PDF to S3
                pdf_key = _s3_key_pdf(user_id, rid, f.filename)
                with open(final_pdf_path, "rb") as fh:
                    put_bytes(pdf_key, fh.read(), content_type=mime)

                # Upload extracted text to S3
                text_key = None
                if USE_S3_TEXT:
                    text_key = _s3_key_text(user_id, rid)
                    put_bytes(
                        text_key,
                        text_out.encode("utf-8"),
                        content_type="text/plain; charset=utf-8",
                    )

                # Optionally delete local copies if we don't want a cache
                if not KEEP_LOCAL_TEXT_CACHE:
                    try:
                        os.remove(final_pdf_path)
                    except Exception:
                        pass
                    try:
                        os.remove(text_path)
                    except Exception:
                        pass

                pdf_path_db = f"s3://{S3_BUCKET}/{pdf_key}"
                text_path_db = f"s3://{S3_BUCKET}/{text_key}" if USE_S3_TEXT else ""
            except Exception as e:
                # IMPORTANT: don't 500 the whole request; log and fall back to local
                print(f"[upload_resume] S3 upload failed, falling back to local: {e}")
                import traceback
                traceback.print_exc()

                pdf_path_db = str(final_pdf_path)
                text_path_db = str(text_path)
        else:
            print(f"[upload_resume] LOCAL mode: USE_S3={USE_S3}, S3_BUCKET={S3_BUCKET!r}")
            pdf_path_db = str(final_pdf_path)
            text_path_db = str(text_path)

        # ======== DB RECORD ========
        with SessionLocal() as s:
            rec = Resume(
                id=rid,
                original_name=f.filename,
                mime_type=mime,
                pdf_path=pdf_path_db,
                text_path=text_path_db,
                size_bytes=file_size,
            )
            s.add(rec)
            s.commit()

        return jsonify({"item": {"id": rid, "original_name": f.filename}}), 201

    except Exception as e:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return jsonify({"error": f"Failed to process file: {e}"}), 500


# --------- View original file (PDF/DOCX) ----------
@app.get("/resumes/<rid>/file")
def get_file(rid):
    """
    Stream the original resume file (PDF/DOCX/etc.) back to the caller.

    Success:
        200 (binary file)

    Errors:
        404 JSON if resume/file not found
        500 JSON if something unexpected goes wrong
    """
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            return jsonify({"error": "Resume not found", "code": 404}), 404

        pdf_path = r.pdf_path

        # ---------- S3 download path ----------
        if _is_s3_url(pdf_path):
            try:
                bucket, key = _split_s3_url(pdf_path)
                data = get_bytes(key)
                return send_file(
                    io.BytesIO(data),
                    mimetype=r.mime_type,
                    as_attachment=False,
                    download_name=r.original_name,
                )
            except FileNotFoundError:
                return jsonify({"error": "Resume file not found in S3", "code": 404}), 404
            except Exception as e:
                return jsonify({"error": f"Failed to read resume from S3: {e}", "code": 500}), 500

        # ---------- Local file path ----------
        # Try DB path first
        if not (pdf_path and os.path.exists(pdf_path)):
            cand = _find_pdf_for_id(r.id)
            if cand:
                pdf_path = cand
                r.pdf_path = cand
                r.size_bytes = os.path.getsize(cand)
                s.add(r)
                s.commit()

        if not (pdf_path and os.path.exists(pdf_path)):
            return jsonify({"error": "Resume file not found", "code": 404}), 404

        try:
            return send_file(
                pdf_path,
                as_attachment=False,
                download_name=r.original_name,
            )
        except Exception as e:
            return jsonify({"error": f"Failed to send resume file: {e}", "code": 500}), 500


# --------- Get extracted text ----------
@app.get("/resumes/<rid>/text")
def get_text(rid):
    """
    Return extracted text for resume <rid>.

    Success:
        200 { "id": "<id>", "text": "..." }

    Errors:
        404 JSON if resume or text not found
        500 JSON if something unexpected fails
    """
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            return jsonify({"error": "Resume not found", "code": 404}), 404

    text_path = r.text_path

    # ----- S3 remote text -----
    if _is_s3_url(text_path):
        try:
            bucket, key = _split_s3_url(text_path)
            data = get_bytes(key)
            return jsonify({"id": r.id, "text": data.decode("utf-8")}), 200
        except FileNotFoundError:
            return jsonify({"error": "Resume text not found in S3", "code": 404}), 404
        except Exception as e:
            return jsonify({"error": f"Failed to read resume text from S3: {e}", "code": 500}), 500

    # ----- Local fallback -----
    if not text_path or not os.path.exists(text_path):
        return jsonify({"error": "Resume text not found", "code": 404}), 404

    try:
        with open(text_path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except FileNotFoundError:
        return jsonify({"error": "Resume text not found", "code": 404}), 404
    except Exception as e:
        return jsonify({"error": f"Failed to read local text file: {e}", "code": 500}), 500

    return jsonify({"id": r.id, "text": content}), 200


# --------- Delete ----------
@app.delete("/resumes/<rid>")
def delete_resume(rid):
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            return jsonify({"error": "Not found"}), 404

        try:
            # Delete PDF (S3 or local)
            if _is_s3_url(r.pdf_path):
                _, key = _split_s3_url(r.pdf_path)
                delete_object(key)
            elif r.pdf_path and os.path.exists(r.pdf_path):
                os.remove(r.pdf_path)

            # Delete extracted text (S3 or local)
            if _is_s3_url(r.text_path):
                _, key = _split_s3_url(r.text_path)
                delete_object(key)
            elif r.text_path and os.path.exists(r.text_path):
                os.remove(r.text_path)
        except Exception as e:
            # Don’t delete DB row if file cleanup exploded
            return jsonify({"error": f"OS cleanup error: {e}"}), 500

        # Only reached if file cleanup succeeded
        s.delete(r)
        s.commit()

    return jsonify({"ok": True})


@app.route("/select_resume", methods=["POST", "OPTIONS"])
def select_resume_api():
    if request.method == "OPTIONS":
        return ("", 204)
    jd = (request.json or {}).get("job_description", "") or ""
    # Build a list like your old JSON format, but from the DB
    items = []
    with SessionLocal() as s:
        for r in s.query(Resume).order_by(Resume.created_at.desc()).all():
            try:
                with open(r.text_path, "r", encoding="utf-8") as fh:
                    txt = fh.read()
                items.append({"id": r.id, "name": r.original_name, "text": txt})
            except Exception:
                continue
    # Reuse your existing selector
    best, ranking = select_best_resume(jd, items)
    return jsonify({"best": best, "ranking": ranking})


@app.route("/match", methods=["POST", "OPTIONS"])
def match():
    if request.method == "OPTIONS":
        return ("", 204)
    """
    Compare resume against job description.

    Input JSON:
        {
          "resume": "...",
          "job_description": "...",
          "method": "tfidf" | "embedding"   (optional, default = tfidf)
        }

    Output JSON:
        {
          "similarity_score": 0.61,                     # similarity score
          "missing_keywords": [["aws", 0.48], ...],     # skills from JD missing in resume
          "method": "tfidf"                             # which matcher was used
        }
    """
    data = request.get_json()

    # Validate input
    if not data or "job_description" not in data:
        return jsonify({"error": "job_description is required"}), 400

    jd_text = data["job_description"]
    resume_text = (data.get("resume") or "").strip()
    rid = data.get("resume_id")

    # If caller didn’t send raw text, allow resume_id
    if not resume_text and rid:
        with SessionLocal() as s:
            r = s.get(Resume, rid)
            if not r:
                return jsonify({"error": "Resume not found"}), 404
            try:
                # If we already have a text_path in DB, use that (S3 or local)
                text_path = r.text_path
                if not text_path or not _is_s3_url(text_path):
                    # For old/local-only rows, repair/migrate if needed
                    text_path = ensure_text_exists(s, r)

                # Read text from either S3 or local
                resume_text = _read_text_any(text_path)
            except FileNotFoundError as e:
                return jsonify({"error": str(e)}), 404
            except Exception as e:
                return jsonify({"error": f"Failed to load resume text: {e}"}), 500

    if not resume_text:
        return jsonify({"error": "resume (text) or resume_id is required"}), 400

    # Choose method (tfidf or embedding)
    method = data.get("method", "tfidf").lower()

    # === Embeddings Matcher ===
    if method == "embedding" and embedding_matcher:
        result = embedding_matcher.match_resume_job(resume_text, jd_text)
        return jsonify(
            {
                "similarity_score": round(float(result["match_score"]), 3),
                "missing_keywords": result["missing_skills"],
                "method": "embedding",
            }
        )

    # === TF-IDF Baseline Matcher (default) ===
    similarity, missing_keywords = tfidf_matcher.get_similarity_and_missing(resume_text, jd_text)

    return jsonify(
        {
            "similarity_score": round(float(similarity), 3),
            "missing_keywords": missing_keywords,
            "method": "tfidf",
        }
    )


# === Health check endpoint ===
@app.route("/health", methods=["GET"])
def health():
    """
    Simple check to see if the server is running.
    If I visit http://127.0.0.1:5000/health
    I should see: { "ok": true }
    """
    return jsonify({"ok": True})


# === Single prediction endpoint ===
@app.route("/predict", methods=["POST", "OPTIONS"])
def predict():
    if request.method == "OPTIONS":
        return ("", 204)
    """
    Input (from extension):
        { "label": "Email Address" }

    What happens:
    - Extract the label text from the JSON
    - Pass it into the ML model
    - Model predicts the field type (like "email", "name", etc.)
    - Also return a confidence score (how sure the model is)

    Output:
        {
          "label": "Email Address",
          "prediction": "email",
          "confidence": 0.91
        }
    """
    payload = request.get_json(force=True, silent=True) or {}
    text = payload.get("label", "")

    # Handle empty input
    if not text.strip():
        return jsonify({"error": "empty label"}), 400

    # Model makes prediction
    prediction = model.predict([text])[0]

    # If model supports probabilities, grab the highest one
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba([text])[0]
        confidence = float(max(probs))
    else:
        confidence = 1.0  # fallback if model doesn’t support probabilities

    return jsonify(
        {
            "label": text,
            "prediction": prediction,
            "confidence": round(confidence, 3),  # round for readability
        }
    )


# === Batch prediction endpoint ===
@app.route("/predict_batch", methods=["POST", "OPTIONS"])
def predict_batch():
    if request.method == "OPTIONS":
        return ("", 204)
    """
    Input:
        { "labels": ["First Name", "Phone Number"] }

    What happens:
    - Loop through each label
    - Predict field type + confidence
    - Collect all results in a list

    Output:
        [
          {"label": "First Name", "prediction": "name", "confidence": 0.87},
          {"label": "Phone Number", "prediction": "phone", "confidence": 0.76}
        ]
    """
    data = request.get_json(force=True, silent=True) or {}
    labels = data.get("labels", [])

    # Must be a list of strings
    if not isinstance(labels, list):
        return jsonify({"error": "labels must be a list"}), 400

    results = []
    for text in labels:
        if not text.strip():
            results.append({"label": text, "prediction": None, "confidence": 0})
            continue

        pred = model.predict([text])[0]

        if hasattr(model, "predict_proba"):
            probs = model.predict_proba([text])[0]
            conf = float(max(probs))
        else:
            conf = 1.0

        results.append({"label": text, "prediction": str(pred), "confidence": round(conf, 3)})

    return jsonify(results)


def choose_dev_port():
    """
    Pick a port for local dev that plays nicely with the Chrome extension.

    The background script will scan this same pool:
        [5000, 5001, 5002, 5003, 5004]

    Can override with SFF_PORT if ever want it fixed again.
    """
    # 1) Allow an explicit override.
    env_port = os.getenv("SFF_PORT")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            print(f"[warn] Ignoring invalid SFF_PORT={env_port!r}", file=sys.stderr)

    # 2) Choose a free one from the pool.
    candidates = [5000, 5001, 5002, 5003, 5004]
    random.shuffle(candidates)
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            # successfully reserved; OS frees it when we close
            return port

    # 3) Fallback.
    return 5000


# === Run the server ===
if __name__ == "__main__":
    port = choose_dev_port()
    print(f"*** Smart Form Filler backend listening on http://127.0.0.1:{port} ***")
    app.run(host="127.0.0.1", port=port)