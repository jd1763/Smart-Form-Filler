"""
Unit tests for BaselineMatcher (TF-IDF)
---------------------------------------

These tests hit the ml/matcher_baseline.py code directly
instead of going through the Flask API.
"""

import pytest
from ml.matcher_baseline import BaselineMatcher


@pytest.fixture
def matcher():
    """Fixture to create a baseline matcher instance."""
    return BaselineMatcher()


def test_similarity_score_is_float(matcher):
    """Similarity score should be a float between 0 and 1."""
    resume = "Python developer with Flask and SQL"
    jd = "Looking for Python developer with Django and SQL"
    similarity, _ = matcher.get_similarity_and_missing(resume, jd)
    assert isinstance(similarity, float)
    assert 0.0 <= similarity <= 1.0


def test_missing_keywords_contains_expected(matcher):
    """'django' should be detected as missing if not in resume."""
    resume = "Python developer with Flask and SQL"
    jd = "Looking for Python developer with Django and SQL"
    _, missing = matcher.get_similarity_and_missing(resume, jd)
    tokens = [kw[0] for kw in missing]
    assert "django" in tokens


def test_missing_keywords_not_flagged_if_present(matcher):
    """'django' should not be marked missing if it is already in resume."""
    resume = "Python developer with Django and Flask experience"
    jd = "Looking for Python developer with Django and SQL"
    _, missing = matcher.get_similarity_and_missing(resume, jd)
    tokens = [kw[0] for kw in missing]
    assert "django" not in tokens
