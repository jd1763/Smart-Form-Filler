import pytest
from backend.api import app

# === Test client fixture ===
# This creates a fake version of the Flask app that pytest can send requests to.
# Instead of running the server for real, we can call endpoints directly in tests.
@pytest.fixture
def client():
    app.testing = True  # put Flask in testing mode (better error handling)
    with app.test_client() as client:
        yield client


# === Test single prediction ===
def test_predict_single(client):
    # Simulate sending one label to /predict
    payload = {"label": "Email Address"}
    response = client.post("/predict", json=payload)

    # Check the request succeeded
    assert response.status_code == 200

    # Check the JSON structure
    data = response.get_json()
    assert "label" in data         # original input echoed back
    assert "prediction" in data    # model's predicted class
    assert "confidence" in data    # confidence score
    assert isinstance(data["confidence"], float)  # confidence is a number


# === Test batch prediction ===
def test_predict_batch(client):
    # Simulate sending multiple labels at once to /predict_batch
    payload = {"labels": ["First Name", "Phone Number"]}
    response = client.post("/predict_batch", json=payload)

    # Check the request succeeded
    assert response.status_code == 200

    # Check the JSON structure
    data = response.get_json()
    assert isinstance(data, list)   # should return a list of predictions
    assert len(data) == 2           # should match number of input labels

    # Each item in the list should include label, prediction, confidence
    for item in data:
        assert "label" in item
        assert "prediction" in item
        assert "confidence" in item
