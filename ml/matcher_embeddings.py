"""
Matcher using Sentence-BERT embeddings
--------------------------------------

This module uses Sentence-BERT embeddings (via sentence-transformers)
to compare resumes and job descriptions.

It returns:
- a similarity score (percentage, 0–100)
- missing skills (keywords in the job description not found in the resume)
"""

import spacy
from sentence_transformers import SentenceTransformer, util


class MatcherEmbeddings:

    def __init__(self, model_name="sentence-transformers/all-MiniLM-L6-v2"):
        """
        Initialize the embedding matcher.
        - Loads a Sentence-BERT model (default: MiniLM-L6-v2).
        - Loads spaCy small English model for keyword extraction.
        """
        print(f"=== Loading embedding model: {model_name} ===")
        self.model = SentenceTransformer(model_name)  # Embedding model
        self.nlp = spacy.load("en_core_web_sm")  # spaCy pipeline for text processing

    def embed(self, text: str):
        """
        Convert input text into an embedding (dense vector).
        Embeddings capture semantic meaning of the text.
        """
        return self.model.encode(text, convert_to_tensor=True)

    def similarity(self, text1: str, text2: str) -> float:
        """
        Compute cosine similarity between two texts.
        Returns a percentage (0–100).
        """
        emb1, emb2 = self.embed(text1), self.embed(text2)
        score = util.cos_sim(emb1, emb2).item()  # Cosine similarity between vectors
        return round(score * 100, 2)  # Convert to percentage for readability

    def extract_keywords(self, text: str):
        """
        Extract candidate keywords from text.
        - Lowercases everything
        - Keeps only nouns & proper nouns
        - Removes stopwords (like 'and', 'the')
        Returns a set of unique keywords.
        """
        doc = self.nlp(text.lower())
        return set(
            token.text.strip().lower()
            for token in doc
            if token.pos_ in ["NOUN", "PROPN"] and not token.is_stop
        )

    def compare_keywords(self, resume_text: str, jd_text: str):
        """
        Compare resume vs job description keywords.
        Returns skills in the job description that are NOT in the resume.
        """
        resume_kw = self.extract_keywords(resume_text)
        jd_kw = self.extract_keywords(jd_text)
        missing = jd_kw - resume_kw
        return list(missing)

    def match_resume_job(self, resume_text: str, jd_text: str):
        """
        High-level function:
        - Computes semantic similarity (resume ↔ JD)
        - Identifies missing keywords
        Returns a dictionary with both.
        """
        score = self.similarity(resume_text, jd_text)
        missing = self.compare_keywords(resume_text, jd_text)
        return {"match_score": score, "missing_skills": missing}


# === Example usage ===
if __name__ == "__main__":
    matcher = MatcherEmbeddings()
    resume = "Experienced Python developer with Flask, REST APIs, and SQL."
    jd = "Looking for a backend engineer with Python, Django, and SQL experience."

    result = matcher.match_resume_job(resume, jd)
    print("Match Score:", result["match_score"])  # e.g., 78.45
    print("Missing Skills:", result["missing_skills"])  # e.g., ["django"]
