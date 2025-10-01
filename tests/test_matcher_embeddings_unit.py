"""
Unit tests for MatcherEmbeddings (Sentence-BERT)
------------------------------------------------

These tests hit the ml/matcher_embeddings.py code directly
instead of going through the Flask API.
"""

import pytest

from ml.matcher_embeddings import MatcherEmbeddings


@pytest.fixture(scope="module")
def matcher():
    """Load the Sentence-BERT matcher once for all tests."""
    return MatcherEmbeddings()


def test_embeddings_smoke():
    m = MatcherEmbeddings()
    out = m.match_resume_job("resume text", "job text")
    assert "match_score" in out


def test_similarity_score_is_percentage(matcher):
    """Embedding similarity should return a percentage (0–100)."""
    resume = "Python developer with Flask and SQL"
    jd = "Looking for Python developer with Django and SQL"
    score = matcher.similarity(resume, jd)
    assert isinstance(score, float)
    assert 0 <= score <= 100


def test_missing_keywords_detects_django(matcher):
    """'django' should be missing if not in the resume."""
    resume = "Python developer with Flask and SQL"
    jd = "Looking for Python developer with Django and SQL"
    result = matcher.match_resume_job(resume, jd)
    assert "django" in [kw.lower() for kw in result["missing_skills"]]


def test_missing_keywords_not_flagged_if_present(matcher):
    """'django' should not be missing if it's already in the resume."""
    resume = "Python developer with Django and Flask experience"
    jd = "Looking for Python developer with Django and SQL"
    result = matcher.match_resume_job(resume, jd)
    assert "django" not in [kw.lower() for kw in result["missing_skills"]]
