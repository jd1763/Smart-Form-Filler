# AI Job Application Assistant

This project combines two ideas into one end-to-end tool that helps job seekers apply smarter:

1. **Smart Form Filler**  
   A Chrome extension that automatically fills job application forms using machine learning.  
   Instead of relying only on exact keyword matches, the extension predicts the meaning of form labels (for example, recognizing that "Surname" means "Last Name") and fills them with stored profile data.

2. **Resume–Job Matcher**  
   A natural language processing (NLP) engine that compares resumes against job descriptions.  
   It produces a match score and highlights missing keywords or skills so applicants can quickly tailor their resumes before submission.

Together, these components form the **AI Job Application Assistant**, a project that applies real-world ML/NLP in a highly relevant and practical way.

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
- [ ] Train a baseline classifier (scikit-learn TF-IDF + Logistic Regression) on `form_labels.csv`.
- [ ] Save as `form_model.pkl`.

**Matcher side**
- [ ] Use TF-IDF similarity (cosine similarity) between resumes and job descriptions.
- [ ] Print match scores for resume-job pairs.

**Deliverables**
- `ml/form_model.pkl`
- `ml/matcher_baseline.py` with similarity scoring

---

### Week 3 — Extension Integration
**Form Filler side**
- [ ] Load `form_model.pkl` into the extension via a Flask API.
- [ ] Replace keyword matching with ML predictions.
- [ ] Add confidence scoring with highlighting.

**Matcher side**
- [ ] Build `matcher_api.py` (Flask).
- [ ] Add `/match` endpoint returning similarity scores + missing keywords.

---

### Week 4 — Embeddings Upgrade
**Matcher side**
- [ ] Switch from TF-IDF to Sentence-BERT embeddings.
- [ ] Use cosine similarity for better semantic matching.
- [ ] Add keyword extraction for skill gap analysis.

---

### Week 5 — UI Improvements
- [ ] Extension popup shows filled fields + confidence bars.
- [ ] Extension sidebar shows match score, missing skills, and best-fit resume.

---

### Week 6 — Advanced Features
- [ ] Multi-resume support (pick best-fit automatically).
- [ ] Smarter field detection for unusual forms.
- [ ] Resume optimizer with dynamic keyword suggestions.

---

### Week 7–8 — Polish & Deploy (Optional)
- [ ] Package extension for Chrome Web Store (developer mode first).
- [ ] Add persistence with SQLite/JSON for resumes and profile data.
- [ ] Deploy Flask backend to Heroku/Render.

---
## Setup

1. Clone this repository:
   ```bash
   git clone https://github.com/jd1763/AI-job-application-assistant.git
   cd AI-job-application-assistant

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
Run preprocessing to clean raw text:
    python ml/preprocess.py

Run tests:
    pytest

## Continuous Integration

This project uses GitHub Actions to run tests on every push.  
CI workflow: `.github/workflows/ci.yml`

**Build Status:**  
![CI](https://github.com/jd1763/AI-job-application-assistant/actions/workflows/ci.yml/badge.svg)
