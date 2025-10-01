import pytest

from backend.api import app as flask_app

# === Test client fixture ===
# Creates a fake Flask client so we can call API endpoints
# without running a real server.


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    return flask_app.test_client()


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["ok"] is True


def test_match_basic(client):
    r = client.post(
        "/match",
        json={
            "job_description": "React developer with AWS and Docker",
            "resume": "Built React apps on AWS with Docker",
            "method": "tfidf",
        },
    )
    assert r.status_code == 200
    out = r.get_json()
    assert "similarity_score" in out
    assert out["method"] == "tfidf"
