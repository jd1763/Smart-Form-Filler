"""
Matcher API for Resume ↔ Job Description
----------------------------------------

This API compares resume text against a job description.

It returns:
- a similarity score (how close the two texts are)
- missing keywords (important terms in the job description that aren’t in the resume)

Endpoints:
    POST /match
        Input:  { "resume": "...", "job_description": "..." }
        Output: { "similarity_score": 0.612,
                  "missing_keywords": [["aws", 0.48], ["docker", 0.37]] }

    GET /health
        Output: { "status": "ok" }
"""

import os
import sys
from flask import Flask, request, jsonify
from flask_cors import CORS
from matcher.baseline_matcher import normalize_text as preprocess_text
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Add the project root to Python path (so we can import matcher/ properly)
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

# === Set up Flask app ===
app = Flask(__name__)
CORS(app)  # allow Chrome extension or frontend apps to call this API

# === Custom stopwords ===
# These are "fluff" words that often appear in job postings but
# aren’t useful as skills (we don’t want them to count as missing keywords).
CUSTOM_STOPWORDS = {
    "requirements", "responsibilities", "qualifications",
    "preferred", "skills", "experience", "knowledge",
    "looking", "look", "must", "ability"
}


def get_similarity_and_missing(resume_text: str, job_desc: str):
    """
    Core logic:
    - Clean up resume and job description text (tokenize, lemmatize, remove stopwords)
    - Vectorize with TF-IDF (turn words into weighted numbers)
    - Compute cosine similarity (how similar the two texts are)
    - Find keywords from job description that don’t appear in resume
    - Attach TF-IDF weights to those keywords so we know which are most important
    """

    # Step 1: Preprocess text with NLTK (from baseline_matcher.py)
    resume_clean = preprocess_text(resume_text)
    jd_clean = preprocess_text(job_desc)

    # Step 2: Turn both texts into TF-IDF vectors
    vectorizer = TfidfVectorizer(stop_words="english")
    tfidf_matrix = vectorizer.fit_transform([resume_clean, jd_clean])

    # Step 3: Compare resume vs job description using cosine similarity
    similarity = cosine_similarity(tfidf_matrix[0:1], tfidf_matrix[1:2])[0][0]

    # Step 4: Extract words from job description vector
    feature_names = vectorizer.get_feature_names_out()
    jd_vector = tfidf_matrix[1].toarray()[0]
    resume_words = set(resume_clean.split())

    # Step 5: Collect missing keywords
    missing_keywords = []
    for idx, word in enumerate(feature_names):
        token = word.lower()
        # Only include if it’s not in resume and not a custom stopword
        if token not in resume_words and token not in CUSTOM_STOPWORDS:
            weight = jd_vector[idx]
            if weight > 0:  # only keep words that matter in JD
                missing_keywords.append((token, round(weight, 3)))

    # Sort by importance (highest TF-IDF first)
    missing_keywords = sorted(missing_keywords, key=lambda x: x[1], reverse=True)
    return similarity, missing_keywords


# === API Endpoints ===

@app.route("/match", methods=["POST"])
def match():
    """
    Input:
        { "resume": "....", "job_description": "...." }

    What happens:
    - Run get_similarity_and_missing()
    - Return a similarity score + missing keywords

    Output:
        {
          "similarity_score": 0.61,
          "missing_keywords": [["aws", 0.48], ["docker", 0.37]]
        }
    """
    data = request.get_json()
    if not data or "resume" not in data or "job_description" not in data:
        return jsonify({"error": "resume and job_description are required"}), 400

    similarity, missing_keywords = get_similarity_and_missing(
        data["resume"], data["job_description"]
    )

    return jsonify({
        "similarity_score": round(float(similarity), 3),
        "missing_keywords": missing_keywords
    })


@app.route("/health", methods=["GET"])
def health():
    """
    Quick check to confirm the API is alive.
    Visiting http://127.0.0.1:5001/health
    should return: { "status": "ok" }
    """
    return jsonify({"status": "ok"})


# === Run the server ===
if __name__ == "__main__":
    # Runs on port 5001 so it doesn’t conflict with form-filler API (5000)
    app.run(debug=True, port=5001)
