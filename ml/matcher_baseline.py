"""
Baseline Matcher (TF-IDF)
-------------------------

This module provides a simple resume -> job description matcher
using TF-IDF vectors and cosine similarity.

It returns:
- similarity score (float between 0–1)
- missing keywords (list of (word, weight) tuples, sorted by importance)
"""

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from matcher.baseline_matcher import normalize_text as preprocess_text

# === Custom stopwords ===
# These are common words in job postings that aren’t useful
# for detecting skill gaps. We filter them out from the "missing" list.
CUSTOM_STOPWORDS = {
    "requirements",
    "responsibilities",
    "qualifications",
    "preferred",
    "skills",
    "experience",
    "knowledge",
    "looking",
    "look",
    "must",
    "ability",
}


class BaselineMatcher:
    def __init__(self):
        """
        Initialize a TF-IDF vectorizer.
        By default, removes English stopwords (like "the", "and").
        """
        self.vectorizer = TfidfVectorizer(stop_words="english")

    def get_similarity_and_missing(self, resume_text: str, job_desc: str):
        """
        Compute similarity + missing keywords between resume and job description.

        Steps:
        1. Clean both texts with preprocess_text() (normalize, lemmatize, remove stopwords).
        2. Vectorize the texts with TF-IDF (turn words into weighted numbers).
        3. Compute cosine similarity between resume and job description vectors.
        4. Extract important words from the JD that don’t appear in the resume.
        5. Return both the similarity score and the missing keywords (sorted by TF-IDF weight).

        Returns:
            similarity (float) - cosine similarity between 0 and 1
            missing_keywords (list) - e.g. [("django", 0.48), ("docker", 0.37)]
        """

        # Step 1: Clean text (normalize and tokenize)
        resume_clean = preprocess_text(resume_text)
        jd_clean = preprocess_text(job_desc)

        # Step 2: TF-IDF vectorization of both texts
        tfidf_matrix = self.vectorizer.fit_transform([resume_clean, jd_clean])

        # Step 3: Cosine similarity between resume (index 0) and JD (index 1)
        similarity = cosine_similarity(tfidf_matrix[0:1], tfidf_matrix[1:2])[0][0]

        # Step 4: Extract feature names and JD weights
        feature_names = self.vectorizer.get_feature_names_out()
        jd_vector = tfidf_matrix[1].toarray()[0]  # vector representation of JD
        resume_words = set(resume_clean.split())  # words present in resume

        # Step 5: Collect keywords that are in JD but not in resume
        missing_keywords = []
        for idx, word in enumerate(feature_names):
            token = word.lower()
            # Only include if it's not in resume and not in the custom stoplist
            if token not in resume_words and token not in CUSTOM_STOPWORDS:
                weight = jd_vector[idx]
                if weight > 0:  # only keep words with significance in JD
                    missing_keywords.append((token, round(weight, 3)))

        # Step 6: Sort keywords by importance (highest TF-IDF first)
        missing_keywords = sorted(missing_keywords, key=lambda x: x[1], reverse=True)

        return similarity, missing_keywords


# === Example usage ===
if __name__ == "__main__":
    matcher = BaselineMatcher()
    resume = "Python developer with Flask and SQL"
    jd = "Looking for Python developer with Django and SQL"
    
    sim, missing = matcher.get_similarity_and_missing(resume, jd)
    print("Similarity Score:", round(sim, 3))          # e.g., 0.42
    print("Missing Keywords:", missing)                # e.g., [("django", 0.51)]
