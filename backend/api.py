"""
My Flask API for Smart Form Filler
----------------------------------

This file runs a small web server that my Chrome extension will talk to.
It loads my trained ML model (`form_model.pkl`) and gives predictions
about what kind of form field a label is (ex: email, name, phone).

The extension sends a label -> this API sends back prediction + confidence.
"""

import os
import sys  # helps build file paths

import joblib  # used to load my saved ML model

# Flask basics for building APIs
from flask import Flask, jsonify, request
from flask_cors import CORS  # lets my Chrome extension call this API without CORS errors

# === Import matchers ===
# - BaselineMatcher: TF-IDF + cosine similarity
# - MatcherEmbeddings: Sentence-BERT embeddings + semantic similarity
from ml.matcher_baseline import BaselineMatcher
from ml.matcher_embeddings import MatcherEmbeddings

from .matcher.resume_selector import load_resumes, select_best_resume

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
RESUMES_FILE = os.path.join(DATA_DIR, "resumes.json")

# Add the project root to Python path so we can import ml/ and backend/ modules
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

# === Path to the model file ===
# I keep my trained scikit-learn model in /models/form_model.pkl
# This builds a path that works no matter where the file is run from.
MODEL_PATH = os.path.join(
    os.path.dirname(__file__),  # start from backend/ folder
    "..",  # go up to project root
    "models",  # into models/ folder
    "form_model.pkl",  # the actual pickle file
)

# === Set up Flask app ===
app = Flask(__name__)
CORS(app)  # allow cross-origin requests (needed for Chrome extension -> API calls)

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


@app.route("/select_resume", methods=["POST", "OPTIONS"])
def select_resume_api():
    if request.method == "OPTIONS":
        return ("", 204)
    jd = (request.json or {}).get("job_description", "")
    resumes = load_resumes(RESUMES_FILE)
    best, ranking = select_best_resume(jd, resumes)
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
    if not data or "resume" not in data or "job_description" not in data:
        return jsonify({"error": "resume and job_description are required"}), 400

    # Choose method (tfidf or embedding)
    method = data.get("method", "tfidf").lower()

    # === Embeddings Matcher ===
    if method == "embedding" and embedding_matcher:
        result = embedding_matcher.match_resume_job(data["resume"], data["job_description"])
        return jsonify(
            {
                "similarity_score": round(float(result["match_score"]), 3),
                "missing_keywords": result["missing_skills"],
                "method": "embedding",
            }
        )

    # === TF-IDF Baseline Matcher (default) ===
    similarity, missing_keywords = tfidf_matcher.get_similarity_and_missing(
        data["resume"], data["job_description"]
    )

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


# === Run the server ===
if __name__ == "__main__":
    # Starts the Flask server at http://127.0.0.1:5000/
    # host=127.0.0.1 means it only runs locally (safe for dev)
    app.run(host="127.0.0.1", port=5000)
