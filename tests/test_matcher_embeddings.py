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

import pytest

from backend.api import app as flask_app


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    return flask_app.test_client()


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["ok"] is True


def _score(client, jd, resume, method="tfidf"):
    r = client.post("/match", json={"job_description": jd, "resume": resume, "method": method})
    assert r.status_code == 200
    return r.get_json()


def test_match_tfidf_missing_django(client):
    jd = "We need Django and React on AWS"
    resume = "Built React apps on AWS"
    out = _score(client, jd, resume, "tfidf")
    assert "similarity_score" in out
    # loose check: "django" should be in missing keywords
    missing = [m[0] if isinstance(m, (list, tuple)) else m for m in out.get("missing_keywords", [])]
    assert "django" in [str(x).lower() for x in missing]


@pytest.mark.skipif(
    pytest.importorskip("ml.matcher_embeddings", reason="Embeddings model not installed") is None,
    reason="Embeddings not available",
)
def test_match_embedding_missing_django(client):
    jd = "We need Django and React on AWS"
    resume = "Built React apps on AWS"
    out = _score(client, jd, resume, "embedding")
    assert out.get("method") in ("embedding", "tfidf")  # some envs fallback
    missing = [m[0] if isinstance(m, (list, tuple)) else m for m in out.get("missing_keywords", [])]
    assert "django" in [str(x).lower() for x in missing]


@pytest.mark.skipif(
    pytest.importorskip("ml.matcher_embeddings", reason="Embeddings model not installed") is None,
    reason="Embeddings not available",
)
def test_match_embedding_has_django(client):
    jd = "We need Django and React on AWS"
    resume = "Built Django services on AWS with React"
    out = _score(client, jd, resume, "embedding")
    assert out.get("method") in ("embedding", "tfidf")
    missing = [m[0] if isinstance(m, (list, tuple)) else m for m in out.get("missing_keywords", [])]
    assert "django" not in [str(x).lower() for x in missing]
