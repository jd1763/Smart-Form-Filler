"""
FastAPI version of my Smart Form Filler backend.

I still keep the original Flask app in backend/api.py. This file just wraps the same
DB/model/S3 helpers in FastAPI so I can:

- run with uvicorn for async + nicer docs
- hit the same routes from the Chrome extension or a React dashboard
- keep behaviour as close to Flask as possible
"""

from __future__ import annotations

import io
import json
import os
import random
import shutil
import socket
import sys
import uuid
from typing import Any, Dict, List, Optional

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

# I reuse everything from my existing Flask api.py so I don't duplicate logic.
# All the DB models, S3 helpers, and ML pieces still live there.
from . import api as legacy  # type: ignore[attr-defined]

# Short aliases so the rest of this file reads cleaner.
SessionLocal = legacy.SessionLocal
Resume = legacy.Resume
MAX_RESUMES = legacy.MAX_RESUMES
PDF_DIR = legacy.PDF_DIR
TEXT_DIR = legacy.TEXT_DIR
PROFILE_PATH = legacy.PROFILE_PATH

USE_S3 = legacy.USE_S3
USE_S3_TEXT = legacy.USE_S3_TEXT
USE_S3_PROFILE = legacy.USE_S3_PROFILE
KEEP_LOCAL_TEXT_CACHE = legacy.KEEP_LOCAL_TEXT_CACHE
S3_BUCKET = legacy.S3_BUCKET
DEFAULT_USER = legacy.DEFAULT_USER

detect_mime = legacy.detect_mime
extract_text_any = legacy.extract_text_any
to_dict = legacy.to_dict
count_resumes = legacy.count_resumes
extract_skills_from_text = legacy.extract_skills_from_text
ensure_text_exists = legacy.ensure_text_exists
_read_text_any = legacy._read_text_any
_is_s3_url = legacy._is_s3_url
_split_s3_url = legacy._split_s3_url
_s3_key_pdf = legacy._s3_key_pdf
_s3_key_text = legacy._s3_key_text
_s3_key_profile = legacy._s3_key_profile

get_bytes = legacy.get_bytes
put_bytes = legacy.put_bytes
delete_object = legacy.delete_object

model = legacy.model
tfidf_matcher = legacy.tfidf_matcher
embedding_matcher = getattr(legacy, "embedding_matcher", None)
select_best_resume = legacy.select_best_resume

app = FastAPI(title="Smart Form Filler – FastAPI backend")

# For now I keep CORS wide open so the Chrome extension + local React dev server
# can both talk to this API without headaches. I can always tighten this later.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _user_id_from_request(request: Request) -> str:
    """
    Try to pull a user id in the same way I do in Flask:
    - ?userId=... query param
    - X-User-Id header
    - falls back to DEFAULT_USER (good enough for local/dev)
    """
    return request.query_params.get("userId") or request.headers.get("X-User-Id") or DEFAULT_USER


# === Health ===


@app.get("/health")
async def health() -> Dict[str, Any]:
    """
    Simple check to see if the FastAPI server is running.
    For tests and the Chrome extension, I keep this identical in shape to the
    Flask /health endpoint: just { "ok": true }.
    """
    return {"ok": True}


# === Profile ===


@app.get("/profile")
async def get_profile(request: Request) -> JSONResponse:
    """
    Read the profile JSON for the current user.

    Behaviour matches my Flask /profile:
    - if USE_S3_PROFILE is on, try S3 first
    - otherwise fall back to the local profile.json file
    - if it doesn't exist yet, return an empty object
    """
    user_id = _user_id_from_request(request)

    # S3 path (what I want for real multi-user later)
    if USE_S3_PROFILE and S3_BUCKET:
        try:
            key = _s3_key_profile(user_id)
            data = get_bytes(key)
            return JSONResponse(content=json.loads(data.decode("utf-8")), status_code=200)
        except Exception:
            # If profile doesn’t exist yet in S3, just behave like an empty profile.
            return JSONResponse(content={}, status_code=200)

    # Local fallback (single profile.json for dev)
    if not PROFILE_PATH.exists():
        return JSONResponse(content={}, status_code=200)

    with open(PROFILE_PATH, "r", encoding="utf-8") as f:
        obj = json.load(f) or {}
    return JSONResponse(content=obj, status_code=200)


@app.post("/profile")
@app.put("/profile")
async def put_profile(
    request: Request,
    data: Dict[str, Any] = Body(default_factory=dict),
) -> JSONResponse:
    """
    Overwrite the profile with whatever JSON the caller sends.

    FastAPI already parsed the JSON into `data` for me, so I just
    write it to S3 or the local profile.json, same as in Flask.
    """
    if data is None:
        data = {}

    user_id: Optional[str] = _user_id_from_request(request)

    if USE_S3_PROFILE and S3_BUCKET and user_id:
        try:
            key = _s3_key_profile(user_id)
            put_bytes(
                key,
                json.dumps(data, ensure_ascii=False).encode("utf-8"),
                content_type="application/json; charset=utf-8",
            )
            return JSONResponse(content=data, status_code=200)
        except Exception as e:  # pragma: no cover
            raise HTTPException(status_code=500, detail=f"Failed to write profile to S3: {e}")

    # Local profile.json
    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Failed to write profile: {e}")

    return JSONResponse(content=data, status_code=200)


@app.patch("/profile")
async def patch_profile(
    request: Request,
    patch: Dict[str, Any] = Body(default_factory=dict),
) -> JSONResponse:
    """
    Patch/merge the existing profile instead of overwriting it.

    This uses the same deep_merge helper I wrote for Flask so the
    behaviour is identical between both backends.
    """
    user_id = _user_id_from_request(request)
    existing: Dict[str, Any] = {}

    # Grab whatever profile exists right now.
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
            raise HTTPException(status_code=500, detail=f"Failed to read profile: {e}")

    merged = legacy.deep_merge(existing, patch or {})

    if USE_S3_PROFILE and S3_BUCKET:
        try:
            key = _s3_key_profile(user_id)
            put_bytes(
                key,
                json.dumps(merged, ensure_ascii=False).encode("utf-8"),
                content_type="application/json; charset=utf-8",
            )
            return JSONResponse(content=merged, status_code=200)
        except Exception as e:  # pragma: no cover
            raise HTTPException(status_code=500, detail=f"Failed to write profile to S3: {e}")

    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
    except Exception as e:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Failed to write profile: {e}")

    return JSONResponse(content=merged, status_code=200)


# === Resumes ===


@app.get("/resumes")
async def list_resumes() -> Dict[str, Any]:
    """
    Return all resumes in newest-first order.

    Same shape as Flask:
        200 { "items": [...], "max": <MAX_RESUMES> }
    """
    try:
        with SessionLocal() as s:
            items = [to_dict(r) for r in s.query(Resume).order_by(Resume.created_at.desc()).all()]
        return {"items": items, "max": MAX_RESUMES}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list resumes: {e}")


@app.post("/resumes", status_code=201)
async def upload_resume(
    request: Request,
    file: UploadFile = File(..., description="PDF or DOCX resume file"),
) -> JSONResponse:
    """
    Handle a single resume upload.

    This mirrors what I do in Flask:
    - enforce MAX_RESUMES
    - save a temp file to sniff the MIME
    - normalise extension (.pdf / .docx)
    - extract text
    - write DB row + optionally push PDF/text to S3
    """
    # Enforce the same MAX_RESUMES limit I already have.
    with SessionLocal() as s:
        if count_resumes(s) >= MAX_RESUMES:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum of {MAX_RESUMES} resumes reached. Delete one to upload another.",
            )

    if file is None or not file.filename:
        raise HTTPException(status_code=400, detail="No file provided or empty filename.")

    # Save to a temporary path so I can figure out the MIME type first.
    tmp_id = str(uuid.uuid4())
    orig_ext = os.path.splitext(file.filename)[1].lower()
    tmp_path = PDF_DIR / f"{tmp_id}{orig_ext or ''}"

    try:
        PDF_DIR.mkdir(parents=True, exist_ok=True)
        with open(tmp_path, "wb") as out:
            shutil.copyfileobj(file.file, out)

        # Prefer what the browser tells me; fall back to the filename.
        mime = file.content_type or detect_mime(file.filename) or detect_mime(str(tmp_path))
        if mime not in (
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ):
            tmp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Only PDF and DOCX are supported.")

        # Normalise extension because sometimes uploads lie.
        if orig_ext not in [".pdf", ".docx"]:
            orig_ext = ".pdf" if mime == "application/pdf" else ".docx"

        rid = str(uuid.uuid4())
        final_pdf_path = PDF_DIR / f"{rid}{orig_ext}"
        tmp_path.rename(final_pdf_path)

        # Extract text into backend/data/text/<rid>.txt
        text_out = extract_text_any(str(final_pdf_path))
        file_size = os.path.getsize(final_pdf_path)

        TEXT_DIR.mkdir(parents=True, exist_ok=True)
        text_path = TEXT_DIR / f"{rid}.txt"
        with open(text_path, "w", encoding="utf-8") as out_txt:
            out_txt.write(text_out or "")

        user_id = _user_id_from_request(request)

        # --- Optional S3 upload ---
        if USE_S3 and S3_BUCKET:
            # PDF to S3
            pdf_key = _s3_key_pdf(user_id, rid, file.filename)
            with open(final_pdf_path, "rb") as fh:
                put_bytes(pdf_key, fh.read(), content_type=mime)

            # Text to S3 (if flag is on)
            if USE_S3_TEXT:
                text_key = _s3_key_text(user_id, rid)
                put_bytes(
                    text_key,
                    (text_out or "").encode("utf-8"),
                    content_type="text/plain; charset=utf-8",
                )

            # If I don't want local copies, clean them up right away.
            if not KEEP_LOCAL_TEXT_CACHE:
                try:
                    final_pdf_path.unlink(missing_ok=True)
                except Exception:
                    pass
                try:
                    text_path.unlink(missing_ok=True)
                except Exception:
                    pass

            pdf_path_db = f"s3://{S3_BUCKET}/{pdf_key}"
            text_path_db = f"s3://{S3_BUCKET}/{text_key}" if USE_S3_TEXT else ""
        else:
            # Local-only mode: store plain paths in the DB.
            pdf_path_db = str(final_pdf_path)
            text_path_db = str(text_path)

        # Create the DB record.
        with SessionLocal() as s:
            rec = Resume(
                id=rid,
                original_name=file.filename,
                mime_type=mime,
                pdf_path=pdf_path_db,
                text_path=text_path_db,
                size_bytes=file_size,
            )
            s.add(rec)
            s.commit()

        return JSONResponse(
            content={"item": {"id": rid, "original_name": file.filename}}, status_code=201
        )

    except HTTPException:
        # Re-raise HTTP errors without wrapping them again.
        raise
    except Exception as e:
        # Clean up temp file on unexpected errors.
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to upload resume: {e}")


@app.get("/resumes/{rid}/file")
async def get_resume_file(rid: str) -> StreamingResponse:
    """
    Stream the original resume file (PDF/DOCX/etc.) back to the caller.
    Supports both S3-backed and local file paths.
    """
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            raise HTTPException(status_code=404, detail="Resume not found")

    pdf_path = r.pdf_path

    # S3-backed file
    if _is_s3_url(pdf_path):
        try:
            _, key = _split_s3_url(pdf_path)
            data = get_bytes(key)
            return StreamingResponse(
                io.BytesIO(data),
                media_type=r.mime_type,
                headers={"Content-Disposition": f'inline; filename="{r.original_name}"'},
            )
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Resume file not found in S3")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read resume from S3: {e}")

    # Local file
    if not pdf_path or not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail="Resume file not found")

    try:
        fh = open(pdf_path, "rb")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Resume file not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read local resume file: {e}")

    return StreamingResponse(
        fh,
        media_type=r.mime_type,
        headers={"Content-Disposition": f'inline; filename="{r.original_name}"'},
    )


@app.get("/resumes/{rid}/text")
async def get_resume_text(rid: str) -> Dict[str, Any]:
    """
    Return the extracted text for a given resume id.

    Shape:
        { "id": "<id>", "text": "..." }
    """
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            raise HTTPException(status_code=404, detail="Resume not found")

    text_path = r.text_path

    # S3-backed text
    if _is_s3_url(text_path):
        try:
            _, key = _split_s3_url(text_path)
            data = get_bytes(key)
            return {"id": r.id, "text": data.decode("utf-8")}
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Resume text not found in S3")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read resume text from S3: {e}")

    # Local text file
    if not text_path or not os.path.exists(text_path):
        raise HTTPException(status_code=404, detail="Resume text not found")

    try:
        with open(text_path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Resume text not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read local text file: {e}")

    return {"id": r.id, "text": content}


@app.delete("/resumes/{rid}")
async def delete_resume(rid: str) -> Dict[str, bool]:
    """
    Delete the resume + its text from DB and storage (local or S3).
    """
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            raise HTTPException(status_code=404, detail="Not found")

        try:
            # Delete PDF
            if _is_s3_url(r.pdf_path):
                _, key = _split_s3_url(r.pdf_path)
                delete_object(key)
            elif r.pdf_path and os.path.exists(r.pdf_path):
                os.remove(r.pdf_path)

            # Delete extracted text
            if _is_s3_url(r.text_path):
                _, key = _split_s3_url(r.text_path)
                delete_object(key)
            elif r.text_path and os.path.exists(r.text_path):
                os.remove(r.text_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"OS cleanup error: {e}")

        s.delete(r)
        s.commit()

    return {"ok": True}


# === Skill helpers ===


@app.get("/debug/skills")
async def debug_skills() -> Dict[str, Any]:
    """
    Quick sanity endpoint so I can see how many skill terms are loaded
    and peek at the first few.
    """
    return {"count": len(legacy.SKILL_TERMS), "sample": legacy.SKILL_TERMS[:20]}


@app.post("/skills/extract")
async def skills_extract(body: Dict[str, Any] = Body(default_factory=dict)) -> Dict[str, Any]:
    """
    POST { "text": "<resume plain text>" } -> { "skills": [...] }.
    """
    text = (body or {}).get("text", "") or ""
    skills = extract_skills_from_text(text)
    return {"skills": skills}


@app.post("/skills/by_resume")
async def skills_by_resume(body: Dict[str, Any] = Body(default_factory=dict)) -> JSONResponse:
    """
    Given a resume id, return the skills I can extract from its text.

    This mirrors my Flask version including the little repair logic:
    - try monkeypatched helpers first (pytest can override these)
    - fall back to DB/S3/local text
    """
    rid = (body or {}).get("resumeId")
    if not rid:
        raise HTTPException(status_code=400, detail="resumeId required")

    text = ""
    name = ""

    # 1) Monkeypatched helpers (pytest can override these on the legacy module).
    try:
        if getattr(legacy, "get_resume_text_by_id", None):
            text = legacy.get_resume_text_by_id(rid)
        if getattr(legacy, "get_resume_name_by_id", None):
            name = legacy.get_resume_name_by_id(rid)
    except Exception:
        text = ""
        name = ""

    # 2) If that didn't give me text, do the slower DB/S3 path.
    if not text or not text.strip():
        with SessionLocal() as s:
            r = s.get(Resume, rid)
            if not r:
                raise HTTPException(status_code=404, detail="Resume not found")

            if not name:
                name = r.original_name or rid

            if not text or not text.strip():
                text_path = r.text_path
                if not text_path or (not _is_s3_url(text_path) and not os.path.exists(text_path)):
                    try:
                        text_path = ensure_text_exists(s, r)
                    except FileNotFoundError as e:
                        raise HTTPException(status_code=404, detail=str(e))
                    except Exception as e:
                        raise HTTPException(
                            status_code=500,
                            detail=f"Failed to load resume text: {e}",
                        )

                text = _read_text_any(text_path)

    skills = extract_skills_from_text(text or "")
    return JSONResponse(content={"id": rid, "name": name, "skills": skills}, status_code=200)


# === Matching & selection ===


@app.post("/select_resume")
async def select_resume_api(body: Dict[str, Any] = Body(default_factory=dict)) -> Dict[str, Any]:
    """
    Given a job description, pick the best resume I have stored.

    For now this just reuses select_best_resume from my matcher module
    and reads resume text straight from disk (same as Flask).
    """
    jd = (body or {}).get("job_description", "") or ""
    items: List[Dict[str, Any]] = []

    with SessionLocal() as s:
        for r in s.query(Resume).order_by(Resume.created_at.desc()).all():
            try:
                with open(r.text_path, "r", encoding="utf-8") as fh:
                    txt = fh.read()
                items.append({"id": r.id, "name": r.original_name, "text": txt})
            except Exception:
                continue

    best, ranking = select_best_resume(jd, items)
    return {"best": best, "ranking": ranking}


@app.post("/match")
async def match(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """
    Compare a resume against a job description.

    Supports:
    - classic TF-IDF baseline (default)
    - embedding matcher (Sentence-BERT) if it's available
    """

    if not body or "job_description" not in body:
        raise HTTPException(status_code=400, detail="job_description is required")

    jd_text = (body.get("job_description") or "").strip()
    if not jd_text:
        raise HTTPException(status_code=400, detail="job_description is required")

    # Prefer explicit resume text if provided
    resume_text = (body.get("resume") or "").strip()
    rid = body.get("resume_id")

    # Allow callers to send just a resume id and pull the text on my side.
    if not resume_text and rid:
        try:
            with SessionLocal() as s:
                r = s.get(Resume, rid)
                if not r:
                    print(f"[match] Resume id {rid} not found")
                else:
                    text_path = r.text_path
                    if not text_path or not _is_s3_url(text_path):
                        text_path = ensure_text_exists(s, r)
                    resume_text = _read_text_any(text_path)
        except FileNotFoundError as e:
            print(f"[match] text file missing for resume {rid}: {e}")
            resume_text = ""
        except Exception as e:
            print(f"[match] unexpected error loading resume {rid}: {e}")
            resume_text = ""

    method = (body.get("method") or "tfidf").lower()

    # If we still don’t have text, soft-fail with score 0 but HTTP 200.
    if not resume_text:
        return {
            "similarity_score": 0.0,
            "missing_keywords": [],
            "method": method,
            "error": "resume (text) or resume_id is required",
        }

    # Embedding-based matcher (if I have it loaded and requested).
    if method == "embedding" and embedding_matcher:
        try:
            result = embedding_matcher.match_resume_job(resume_text, jd_text)
            return {
                "similarity_score": round(float(result["match_score"]), 3),
                "missing_keywords": result.get("missing_skills", []),
                "method": "embedding",
            }
        except Exception as e:
            # Log and fall back to TF-IDF
            print(f"[match] embedding matcher failed, falling back to tfidf: {e}")

    # TF-IDF baseline matcher (default path / embedding fallback).
    similarity, missing_keywords = tfidf_matcher.get_similarity_and_missing(resume_text, jd_text)
    return {
        "similarity_score": round(float(similarity), 3),
        "missing_keywords": missing_keywords,
        "method": "tfidf" if method != "embedding" else "embedding-fallback",
    }


# === Prediction ===


@app.post("/predict")
async def predict(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """
    Single label -> prediction + confidence.

    Input:
        { "label": "Email Address" }

    Output:
        {
          "label": "Email Address",
          "prediction": "...",
          "confidence": 0.91
        }
    """
    text = (body or {}).get("label", "") or ""
    if not text.strip():
        raise HTTPException(status_code=400, detail="empty label")

    prediction = model.predict([text])[0]
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba([text])[0]
        confidence = float(max(probs))
    else:
        confidence = 1.0

    return {
        "label": text,
        "prediction": str(prediction),
        "confidence": round(confidence, 3),
    }


@app.post("/predict_batch")
async def predict_batch(body: Dict[str, Any] = Body(...)) -> List[Dict[str, Any]]:
    """
    Batch version of /predict.

    Input:
        { "labels": ["First Name", "Phone Number"] }

    Output:
        [
          { "label": "...", "prediction": "...", "confidence": 0.87 },
          ...
        ]
    """
    labels = (body or {}).get("labels", [])
    if not isinstance(labels, list):
        raise HTTPException(status_code=400, detail="labels must be a list")

    results: List[Dict[str, Any]] = []
    for text in labels:
        if not isinstance(text, str) or not text.strip():
            results.append({"label": text, "prediction": None, "confidence": 0})
            continue

        pred = model.predict([text])[0]
        if hasattr(model, "predict_proba"):
            probs = model.predict_proba([text])[0]
            conf = float(max(probs))
        else:
            conf = 1.0

        results.append({"label": text, "prediction": str(pred), "confidence": round(conf, 3)})

    return results


def choose_dev_port_v2() -> int:
    """
    Pick a port for the FastAPI dev server that does NOT clash with my Flask api.py.

    Flask (legacy api.py) uses [5000, 5001, 5002, 5003, 5004].
    For FastAPI I reserve a separate pool:
        [6000, 6001, 6002, 6003, 6004]

    This keeps the Chrome extension logic simple: it can just scan both pools.
    You can still override with SFF_PORT_V2 if you ever want a fixed port.
    """
    # 1) Allow an explicit override for FastAPI.
    env_port = os.getenv("SFF_PORT_V2")
    if env_port:
        try:
            return int(env_port)
        except ValueError:
            print(f"[warn] Ignoring invalid SFF_PORT_V2={env_port!r}", file=sys.stderr)

    # 2) Choose a free one from the FastAPI pool.
    candidates = [6000, 6001, 6002, 6003, 6004]
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

    # 3) Fallback: last resort if everything in the pool was busy.
    return 6000


# === Run the server ===
# I like having this here so I can just do:
#   python -m backend.fastapi_app
# in local dev and not have to remember the uvicorn command every time.
if __name__ == "__main__":
    import uvicorn

    # Reuse the same helper I use in my Flask api.py so the Chrome extension
    # can keep scanning the same dev port pool.
    port = choose_dev_port_v2()
    print(f"*** Smart Form Filler FastAPI backend listening on " f"http://127.0.0.1:{port} ***")

    # Run FastAPI with uvicorn on the chosen port.
    # Here I pass the app object directly instead of an import string.
    uvicorn.run(app, host="127.0.0.1", port=port)
