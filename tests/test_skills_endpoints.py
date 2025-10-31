import pytest

from backend import api


@pytest.fixture(scope="module")
def client():
    api.app.config["TESTING"] = True
    with api.app.test_client() as c:
        yield c


def test_skills_extract_basic(client):
    """
    POST /skills/extract should return a JSON object with 'skills' as an array.
    The array should contain normalized skill hits from the input text.
    """
    payload = {"text": "Experienced with Python, SQL, React and Docker. Also used AWS Lambda."}
    resp = client.post("/skills/extract", json=payload)
    assert resp.status_code == 200

    data = resp.get_json()
    assert isinstance(data, dict)
    assert "skills" in data
    assert isinstance(data["skills"], list)

    # basic sanity: a few expected skills present
    # (exact terms depend on your SKILL_TERMS; adjust if needed)
    expected_any = {"python", "sql", "react", "docker", "aws", "lambda"}
    assert expected_any.intersection(set(data["skills"]))  # at least one hit


def test_skills_extract_empty_text(client):
    """
    Empty text should not error and should return an empty list.
    """
    resp = client.post("/skills/extract", json={"text": ""})
    assert resp.status_code == 200
    data = resp.get_json()
    assert "skills" in data
    assert isinstance(data["skills"], list)
    assert data["skills"] == []


def test_skills_by_resume_requires_id(client):
    """
    Missing resumeId should return 400 with an error message.
    """
    resp = client.post("/skills/by_resume", json={})
    assert resp.status_code == 400
    data = resp.get_json()
    assert isinstance(data, dict)
    assert "error" in data


def test_skills_by_resume_happy_path(client, monkeypatch):
    """
    With a valid resumeId, the endpoint should return {id, name, skills[]}.
    We monkeypatch the two helper functions so the test is independent
    of the resumes storage implementation.
    """

    # Arrange: patch helpers inside api.py
    def fake_get_resume_text_by_id(resume_id: str) -> str:
        assert resume_id == "r-123"
        return "Python and Java on backend, React on frontend; AWS EC2 and Docker."

    def fake_get_resume_name_by_id(resume_id: str) -> str:
        assert resume_id == "r-123"
        return "my_resume.pdf"

    monkeypatch.setattr(api, "get_resume_text_by_id", fake_get_resume_text_by_id, raising=False)
    monkeypatch.setattr(api, "get_resume_name_by_id", fake_get_resume_name_by_id, raising=False)

    # Act
    resp = client.post("/skills/by_resume", json={"resumeId": "r-123"})
    assert resp.status_code == 200

    data = resp.get_json()
    # Assert shape
    assert isinstance(data, dict)
    assert data.get("id") == "r-123"
    assert data.get("name") == "my_resume.pdf"
    assert "skills" in data and isinstance(data["skills"], list)

    # basic sanity: confirm at least some expected skills appear
    expected = {"python", "java", "react", "aws", "ec2", "docker"}
    assert expected.intersection(set(data["skills"]))


def test_skills_by_resume_multiple_ids(client, monkeypatch):
    """
    Parametrized style without pytest.parametrize (keeps it simple):
    test that for multiple resumeIds we still get arrays and the
    returned 'id' echoes the request.
    """
    texts = {
        "r1": "C++, Linux, Bash; Kubernetes on GCP.",
        "r2": "TypeScript, Node, Express; PostgreSQL and REST APIs.",
        "r3": "Swift for iOS, Unit testing with XCTest; Git workflows.",
    }
    names = {"r1": "one.pdf", "r2": "two.pdf", "r3": "three.pdf"}

    def fake_get_resume_text_by_id(resume_id: str) -> str:
        return texts.get(resume_id, "")

    def fake_get_resume_name_by_id(resume_id: str) -> str:
        return names.get(resume_id, "")

    monkeypatch.setattr(api, "get_resume_text_by_id", fake_get_resume_text_by_id, raising=False)
    monkeypatch.setattr(api, "get_resume_name_by_id", fake_get_resume_name_by_id, raising=False)

    for rid in ["r1", "r2", "r3"]:
        resp = client.post("/skills/by_resume", json={"resumeId": rid})
        assert resp.status_code == 200

        data = resp.get_json()
        assert data.get("id") == rid
        assert data.get("name") == names[rid]
        assert isinstance(data.get("skills"), list)

        # Each should have at least one recognizable skill
        assert len(data["skills"]) >= 1
