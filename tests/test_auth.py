from fastapi.testclient import TestClient

from backend.api import SessionLocal, User
from backend.fastapi_app import app

TEST_USERNAME = "pytest_user"
TEST_EMAIL = "pytest_user@example.com"
TEST_PASSWORD = "pytest-secret-123"
TEST_FIRST = "Py"
TEST_LAST = "Test"


def _cleanup_test_user():
    # Remove the test user if it exists so tests are repeatable
    with SessionLocal() as s:
        user = s.query(User).filter(User.username == TEST_USERNAME).first()
        if user:
            s.delete(user)
            s.commit()


def test_register_login_and_me():
    client = TestClient(app)

    # Make sure leftover user from a previous run is gone
    _cleanup_test_user()

    # 1) Register (new payload shape)
    resp = client.post(
        "/auth/register",
        json={
            "username": TEST_USERNAME,
            "email": TEST_EMAIL,
            "firstName": TEST_FIRST,
            "lastName": TEST_LAST,
            "password": TEST_PASSWORD,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["user"]["username"] == TEST_USERNAME
    assert data["user"]["email"] == TEST_EMAIL

    # 2) Login (username/password)
    resp_login = client.post(
        "/auth/login",
        json={"username": TEST_USERNAME, "password": TEST_PASSWORD},
    )
    assert resp_login.status_code == 200
    data_login = resp_login.json()
    token = data_login["access_token"]
    assert token

    # 3) /auth/me with token
    headers = {"Authorization": f"Bearer {token}"}
    resp_me = client.get("/auth/me", headers=headers)
    assert resp_me.status_code == 200
    me = resp_me.json()
    assert me["username"] == TEST_USERNAME
    assert me["email"] == TEST_EMAIL

    _cleanup_test_user()


def test_login_wrong_password():
    client = TestClient(app)

    # Ensure we have a known user
    _cleanup_test_user()
    resp = client.post(
        "/auth/register",
        json={
            "username": TEST_USERNAME,
            "email": TEST_EMAIL,
            "firstName": TEST_FIRST,
            "lastName": TEST_LAST,
            "password": TEST_PASSWORD,
        },
    )
    assert resp.status_code == 200

    # Wrong password should give 401
    resp_bad = client.post(
        "/auth/login",
        json={"username": TEST_USERNAME, "password": "wrong-password"},
    )
    assert resp_bad.status_code == 401
    assert resp_bad.json()["detail"] == "Invalid username or password"

    _cleanup_test_user()
