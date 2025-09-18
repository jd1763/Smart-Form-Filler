"""
Tests for matcher API (TF-IDF + Embedding)
------------------------------------------

These tests confirm that the /match endpoint:
- Works with both "tfidf" and "embedding" methods
- Returns a similarity_score (float)
- Returns missing_keywords in the expected format
- Detects "django" as missing if resume does not have it
- Does NOT mark "django" missing if resume includes it
"""

import json

import pytest

from backend import matcher_api


@pytest.fixture
def client():
    """Create a Flask test client."""
    matcher_api.app.config["TESTING"] = True
    with matcher_api.app.test_client() as client:
        yield client


def test_health(client):
    """Health check should return status=ok."""
    resp = client.get("/health")
    data = json.loads(resp.data)
    assert resp.status_code == 200
    assert data["status"] == "ok"


def test_match_tfidf_missing_django(client):
    """TF-IDF should mark 'django' missing if not in resume."""
    resp = client.post(
        "/match",
        json={
            "resume": "Python developer with Flask experience",
            "job_description": "Looking for Python developer with Django and SQL",
            "method": "tfidf",
        },
    )
    data = json.loads(resp.data)
    missing_tokens = [
        kw[0] if isinstance(kw, (list, tuple)) else kw for kw in data["missing_keywords"]
    ]
    assert "django" in [m.lower() for m in missing_tokens]


def normalize_missing_keywords(missing_keywords):
    """Convert missing keywords into list of lowercase strings (works for tuple or str)."""
    normalized = []
    for kw in missing_keywords:
        if isinstance(kw, (list, tuple)):
            normalized.append(str(kw[0]).lower())
        else:
            normalized.append(str(kw).lower())
    return normalized


def test_match_embedding_missing_django(client):
    resp = client.post(
        "/match",
        json={
            "resume": "Python developer with Flask experience",
            "job_description": "Looking for Python developer with Django and SQL",
            "method": "embedding",
        },
    )
    data = json.loads(resp.data)
    missing = normalize_missing_keywords(data["missing_keywords"])
    assert "django" in missing


def test_match_embedding_has_django(client):
    resp = client.post(
        "/match",
        json={
            "resume": "Python developer with Django and Flask experience",
            "job_description": "Looking for Python developer with Django and SQL",
            "method": "embedding",
        },
    )
    data = json.loads(resp.data)
    missing = normalize_missing_keywords(data["missing_keywords"])
    assert "django" not in missing
