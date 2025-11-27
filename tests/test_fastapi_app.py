import pytest
from fastapi.testclient import TestClient

from backend.fastapi_app import app as fastapi_app


# === Test client fixture (FastAPI) ===
# Same idea as my Flask tests: wrap the app in a client so pytest can
# hit endpoints directly without running a real server.
@pytest.fixture
def client():
    return TestClient(fastapi_app)


# === /health ===
def test_fastapi_health_ok(client):
    """
    Basic sanity check that the FastAPI server responds to /health
    with the same shape I use in Flask.
    """
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


# === /predict (single) ===
def test_fastapi_predict_single(client):
    """
    Make sure FastAPI /predict behaves like the Flask version.

    I send one label, and expect:
    - 200 OK
    - JSON with label, prediction, confidence
    """
    payload = {"label": "Email Address"}
    response = client.post("/predict", json=payload)

    assert response.status_code == 200

    data = response.json()
    assert "label" in data
    assert "prediction" in data
    assert "confidence" in data
    assert isinstance(data["confidence"], float)


# === /predict_batch ===
def test_fastapi_predict_batch(client):
    """
    Same batch test as in test_api.py but against the FastAPI app.

    I send two labels, and expect:
    - 200 OK
    - list of two items
    - each item has label, prediction, confidence
    """
    payload = {"labels": ["First Name", "Phone Number"]}
    response = client.post("/predict_batch", json=payload)

    assert response.status_code == 200

    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 2

    for item in data:
        assert "label" in item
        assert "prediction" in item
        assert "confidence" in item
