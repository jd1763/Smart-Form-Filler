"""
Matcher API for Resume -> Job Description
----------------------------------------

This API compares resume text against a job description.

It returns:
- a similarity score (how close the two texts are)
- missing keywords (important terms in the job description that aren’t in the resume)

Endpoints:
    POST /match
        Input:  { "resume": "...", "job_description": "..." }
        Output: { "similarity_score": 0.612,
                  "missing_keywords": [["aws", 0.48], ["docker", 0.37]],
                  "method": "tfidf" | "embedding" }

    GET /health
        Output: { "status": "ok" }
"""

import os
import sys

from flask import Flask, jsonify, request
from flask_cors import CORS

# === Import matchers ===
# - BaselineMatcher: TF-IDF + cosine similarity
# - MatcherEmbeddings: Sentence-BERT embeddings + semantic similarity
from ml.matcher_baseline import BaselineMatcher
from ml.matcher_embeddings import MatcherEmbeddings

# === Path setup ===
# Add the project root to Python path so we can import ml/ and backend/ modules
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

# === Set up Flask app ===
app = Flask(__name__)
CORS(app)  # Allow requests from browser extensions or frontends (CORS enabled)

# === Instantiate matchers ===
tfidf_matcher = BaselineMatcher()  # baseline TF-IDF matcher
try:
    embedding_matcher = MatcherEmbeddings()  # try to load embedding model
except Exception as e:
    # If embeddings fail to load (e.g. no GPU, missing package), fall back to TF-IDF only
    embedding_matcher = None
    print(f"[WARNING] Could not load embeddings matcher: {e}")


@app.route("/match", methods=["POST"])
def match():
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


@app.route("/health", methods=["GET"])
def health():
    """
    Simple health check endpoint.
    Visiting http://127.0.0.1:5001/health should return:
        { "status": "ok" }
    """
    return jsonify({"status": "ok"})


# === Run the server ===
if __name__ == "__main__":
    # Run on port 5001 so it doesn’t conflict with the Form Filler API (port 5000).
    # Debug=True enables live reload + error traces (dev only, not for production).
    app.run(debug=True, port=5001)
