# Smart Form Filler

This project combines two ideas into one end-to-end tool that helps job seekers apply smarter:

1. **Smart Form Filler**  
   A Chrome extension that automatically fills job application forms using machine learning.  
   Instead of relying only on exact keyword matches, the extension predicts the meaning of form labels (for example, recognizing that "Surname" means "Last Name") and fills them with stored profile data.

2. **Resume–Job Matcher**  
   A natural language processing (NLP) engine that compares resumes against job descriptions.  
   It produces a match score and highlights missing keywords or skills so applicants can quickly tailor their resumes before submission.

Together, these components form the **Smart Form Filler**, a project that applies real-world ML/NLP in a highly relevant and practical way.

For a visual representation of the project, watch this video: [DEMO](https://drive.google.com/file/d/1Hz1tvYp8fivobtalJ0PJ5slyo_Caw2rC/view)

---

## Features
- Autofills job application forms with machine learning instead of brittle rules.
- Reads job descriptions and compares them against resumes.
- Provides a match score and suggests missing keywords.
- Confidence scores for form filling, so the user knows which fields may need review.
- Designed for eventual integration as a Chrome extension with a sidebar interface.

---

## Project Roadmap

### Final Goal
A Chrome Extension that:
- Autofills job application forms (Smart Form Filler ML)
- Reads job descriptions and compares them to your resumes (Matcher NLP)
- Gives you a match score plus missing keywords before submission

---

### Week 1 — Data & Setup (completed)
**Form Filler side**
- [x] Collected real-world forms (Techlistic, W3Schools, job portals).
- [x] Saved HTML snippets in `dataset/forms/`.
- [x] Built `form_labels.csv` with over 80 variations mapped to field types.

**Matcher side**
- [x] Collected raw job descriptions (`dataset/jobs/`).
- [x] Collected resumes (`dataset/resumes/`), including dummy samples and my own.
- [x] Wrote `preprocess.py` for text cleaning (lowercase, stopwords, punctuation removal).
- [x] Generated cleaned text in `jobs_clean/` and `resumes_clean/`.

---

### Week 2 — Baseline Models
**Form Filler side**
- [x] Train a baseline classifier (scikit-learn TF-IDF + Logistic Regression) on `form_labels.csv`.
- [x] Save as `form_model.pkl`.

**Matcher side**
- [x] Use TF-IDF similarity (cosine similarity) between resumes and job descriptions.
- [x] Print match scores for resume-job pairs.

**Deliverables**
- `ml/form_model.pkl`
- `ml/matcher_baseline.py` with similarity scoring

---

### Week 3 — Extension Integration
**Form Filler side**
- [x] Load `form_model.pkl` into the extension via a Flask API.
- [x] Replace keyword matching with ML predictions.
- [x] Add confidence scoring with highlighting.

**Matcher side**
- [x] Build `matcher_api.py` (Flask).
- [x] Add `/match` endpoint returning similarity scores + missing keywords.

---

### Week 4 — Embeddings Upgrade
**Matcher side**
- [x] Switch from TF-IDF to Sentence-BERT embeddings.
- [x] Use cosine similarity for better semantic matching.
- [x] Add keyword extraction for skill gap analysis.

---

### Week 5 — UI Improvements
**Form Filler (popup)**
- [x] Shows **filled fields** with **confidence bars** and compact summaries.
- [x] Restored & wired **Fill Form** / **Try Again** actions.
- [x] Per-page state (collapse/expand) **persists** in `chrome.storage.local`.
- [x] Robust content-script injection & best-frame selection (no more “receiving end” errors).

**Matcher (popup)**
- [x] **Auto-detects** the job description from the active tab (injects `content.js` if needed).
- [x] **Hides** the Job Match card on non-JD pages (minimum length + minimum skill-keyword gate).
- [x] Computes a **realistic blended score**:
  - Runs **both** methods (TF-IDF + Embedding) and averages model similarity.
  - Extracts JD skills via a whitelist; distinguishes **Required** vs **Preferred**.
  - Uses **weighted coverage** (Required » Other » Preferred).
  - Applies **non-linear penalties** + **caps** (required gaps hurt more; preferred gaps hurt less).
  - Never shows “perfect” when anything is missing.
- [x] Displays **Matched** and **Missing** skills as chips (cleaned via whitelist).
- [x] Footer shows **Using:** `<resume name>` **· added** `<date, time>` (no method leakage).
- [x] Seeds resume from bundled file: `data/resumes/resume11_jorgeluis_done.txt` (with `lastUpdated`).

**Platform/Infra**
- [x] `manifest.json`: added `web_accessible_resources` for the bundled resume.
- [x] Background: cleaned message routing; ensured the toolbar click opens the **popup** (not a side panel).
- [x] Content messaging standardized (`action: "EXT_GET_JOB_DESC"`) and auto-injected script.

**Testing**
- [x] Added **Easy JD Test** HTML to validate extraction and scoring.
- [x] Verified matcher endpoints:
  - `api.py` → `http://127.0.0.1:5000/predict`
  - `matcher_api.py` → `http://127.0.0.1:5001/match`

**Deliverable**
- [x] **Interactive Chrome Extension UI** with both:
  - Form-filler feedback (filled fields + confidence).
  - Matcher feedback (score with realistic weighting, matched/missing skill chips; footer with resume metadata).

---

### Week 6 — Advanced Features
- [x] **Multi-resume support**  
  - Extension auto-picks the best resume for the detected job description.  
  - Suggested resume stays frozen; user can compare others via dropdown.  
  - Inline resume picker always visible, defaults to last choice, and persists.  

- [x] **Smarter field detection for unusual forms**  
  - `content.js` improved DOM parsing: detects labels, placeholders, ARIA attributes, and hidden form structures.  
  - Handles iframes and “best frame” selection for forms in nested documents.  
  - Confidence bars + field grouping polished for better clarity.  

**Deliverable:**  
Full MVP of **AI Job Application Assistant**, combining the smart form filler and job-resume matcher into one interactive Chrome Extension.

---

### Week 7 — Polish (Resume Vault + Profile Backend + Popup UX)

### What’s new
- **Backend Resume Vault**
  - `POST /resumes` — upload PDF/DOCX. We save the original file and extract text to `.txt`.
  - `GET /resumes` — list uploaded resumes (id, name, size, created_at).
  - `GET /resumes/<id>/file` — stream the original PDF/DOCX (for “View PDF” in UI).
  - `GET /resumes/<id>/text` — returns extracted text (debug).
  - `DELETE /resumes/<id>` — removes DB row + files.
  - **Storage root:** `backend/data/` (not inside the extension). Original files under `data/resumes/`, extracted text under `data/text/`.
  - **Limit:** max 5 resumes enforced server-side.

- **Matcher & Resume Suggestor**
  - Popup now loads resumes from the backend and calls:
    - `POST /match` with `{ resume_id, job_description }`.
  - `/match` accepts either `resume_id` (preferred) or raw `resume` text and returns:
    - `similarity_score` (0–1), `missing_keywords`, and which method was used.
  - **Self-healing paths:** if files were moved from `uploads/` to `data/`, `/match` repairs paths and re-extracts text as needed.

- **Profile (“Edit My Answers”) — server-backed**
  - New endpoints:
    - `GET /profile` → serve `backend/data/profile.json`.
    - `POST /profile` → save edits to `backend/data/profile.json`.
  - Editor UI supports:
    - **Degree single dropdown** (e.g., “B.S. — Bachelor of Science”) mapped to `degreeShort` + `degreeLong`.
    - **Month/Year selectors** for Education and Experience (`startMonth`, `startYear`, `endMonth`, `endYear`).
    - Date of Birth as native `<input type=date>`.
    - Eligibility/self-ID radios & selects with clean alignment.
  - “Fill This Page Now” sends the current in-memory profile to the content script (`EXT_FILL_FROM_PROFILE`).

- **Popup UX**
  - **No resumes on file** card with CTA → “Upload resume” opens the Manage Resumes page.
  - Removed the old **Fill (My Answers)** button from popup to avoid clutter.
  - CSP violation fixed by removing inline `<script>` in `popup.html` and moving handlers to `popup.js`.

- **Styling**
  - Centralized button/hover/focus styles and select focus rings in `styles.css`.

## Week 8–9 (Oct 17–26, 2025)

- Robust label resolver:
  - Added `label[for]` resolution for all control types (not just checkboxes).
  - Improved fallbacks to `aria-label`, fieldset legends, and nearest group headers.
- EEO & Demographics:
  - Support for radio/select variants (Hispanic/Latino/a/x, LGBTQ+, Veteran, Disability), with broader regex synonyms.
- Education/Experience stability:
  - Prevent ML/detection post-pass from overwriting structured rows (`#eduList`, `#expList`).
  - DOM-based row indexing for stable per-row mapping.
  - Fixed experience row counter to avoid cross-referencing education counts.
- “Current job” UX:
  - Profile stores `isCurrent: true` without baking end dates.
  - At fill time, end month/year are computed dynamically (timezone-safe) and optional “Present/Current” controls are toggled if present.
- Popup accuracy:
  - Detected count is stable before/after opening the dropdown.
  - Detected list always shows labels (no option values/placeholder text).
  - Filled/Nonfilled panels refresh from page state after each Fill action.
- Tests:
  - Added second Employment section with a “Present/Current” checkbox to exercise dynamic end-date logic.


---
## Setup

## Setup (Quickstart)

> For the full, always-up-to-date guide, see **[run_instructions.txt](./run_instructions.txt)**.  
> That file is the source of truth; update it when steps change.

1. Clone this repository:
   ```bash
   git clone https://github.com/jd1763/Smart-Form-Filler.git
   cd Smart-Form-Filler

2. Create a virtual environment:
    python3 -m venv .venv

3. Activate the virtual environment (required for every session):
    source .venv/bin/activate

    Important: Always run this command before using pip or pytest.
    Otherwise, you may see errors like command not found: pip or ModuleNotFoundError.

4. Install dependencies:
    pip install -r requirements.txt
    pip install -r requirements-dev.txt   # optional dev tool

## Usage
Run the core API
    python -m backend.api
    # Default: http://127.0.0.1:5000

Health check
    curl http://127.0.0.1:5001/health
    # Should be -> { "status": "ok" }
    
Compare resume and job description (TF-IDF baseline)
    curl -X POST http://127.0.0.1:5001/match \
        -H "Content-Type: application/json" \
        -d '{"resume":"Python, Flask, SQL","job_description":"Looking for Python developer with Django and SQL","method":"tfidf"}'

Example output:
    {
        "similarity_score": 0.62,
        "missing_keywords": [["django", 0.41], ["developer", 0.23]],
        "method": "tfidf"
    }

Compare resume and job description (Sentence-BERT embeddings)
    curl -X POST http://127.0.0.1:5001/match \
        -H "Content-Type: application/json" \
        -d '{"resume":"Python, Flask, SQL","job_description":"Looking for Python developer with Django and SQL","method":"embedding"}'

Example output:
    {
        "similarity_score": 84.32,
        "missing_keywords": ["django"],
        "method": "embedding"
    }

Run tests:
    pytest -v

## Continuous Integration

This project uses GitHub Actions to run tests on every push.  
CI workflow: `.github/workflows/ci.yml`

**Build Status:**  
![CI](https://github.com/jd1763/AI-job-application-assistant/actions/workflows/ci.yml/badge.svg)
