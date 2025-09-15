import pytest

from backend.matcher_api import app


# === Test client fixture ===
# Creates a fake Flask client so we can call API endpoints
# without running a real server.
@pytest.fixture
def client():
    app.testing = True
    with app.test_client() as client:
        yield client


# === Test the /match endpoint ===
def test_match_endpoint(client):
    # Input: fake resume and job description
    payload = {
        "resume": "Experienced in Python and SQL",
        "job_description": "Looking for Python, SQL, AWS, and Docker",
    }

    # Send POST request to /match
    response = client.post("/match", json=payload)

    # Check request succeeded
    assert response.status_code == 200

    # Parse JSON response
    data = response.get_json()
    assert "similarity_score" in data  # numeric similarity value
    assert "missing_keywords" in data  # list of (keyword, score) pairs

    # Pull out just the keyword names from missing keywords
    missing_words = [kw[0] for kw in data["missing_keywords"]]

    # Important skills "aws" and "docker" should be marked missing
    assert "aws" in missing_words
    assert "docker" in missing_words

    # Stopwords like "look"/"looking" should NOT be flagged
    assert "look" not in missing_words
    assert "looking" not in missing_words
