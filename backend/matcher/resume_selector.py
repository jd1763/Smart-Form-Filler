import re
from typing import Dict, List, Tuple

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

BUMP_TERMS = {
    "java": 1.25,
    "python": 1.15,
    "react": 1.25,
    "android": 1.2,
    "aws": 1.2,
    "sql": 1.2,
    "kubernetes": 1.2,
    "docker": 1.15,
}


def _prep(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s\-\+\.#]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def select_best_resume(jd_text: str, resumes: List[Dict]) -> Tuple[Dict, List[Tuple[str, float]]]:
    if not resumes:
        return None, []
    docs = [_prep(jd_text)] + [_prep(r.get("text", "")) for r in resumes]
    # filter out truly empty strings to avoid "empty vocabulary" error
    if not any(d for d in docs):
        raise ValueError("JD and resumes are empty after preprocessing.")
    # if JD is empty but resumes are not, keep going
    if not any(d for d in docs[1:]):
        raise ValueError("All resume texts are empty after preprocessing.")

    vec = TfidfVectorizer(ngram_range=(1, 2), min_df=1, stop_words="english")
    X = vec.fit_transform(docs)  # this is where empty vocab would throw
    sims = cosine_similarity(X[0], X[1:]).flatten()

    jd_tokens = set(_prep(jd_text).split())
    bumped = []
    for i, score in enumerate(sims):
        bonus = 0.0
        for term, w in BUMP_TERMS.items():
            if term in jd_tokens and term in resumes[i].get("text", "").lower():
                bonus += 0.02 * (w - 1.0)
        bumped.append(score + bonus)

    ranked = sorted(zip(resumes, bumped), key=lambda x: x[1], reverse=True)
    best = ranked[0][0]
    ranking = [(r["id"], float(s)) for r, s in ranked]
    return best, ranking
