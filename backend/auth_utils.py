import datetime as dt
import hashlib
import hmac
import os
import secrets
import jwt  # PyJWT

# --- Password hashing (PBKDF2) ---

_PBKDF2_ITERATIONS = 100_000
_PBKDF2_ALG = "sha256"


def hash_password(plain: str) -> str:
    """
    Hash a password using PBKDF2-HMAC-SHA256 with a random salt.
    Stored format: "<hex_salt>$<hex_hash>"
    """
    if not plain:
        raise ValueError("Password cannot be empty")

    salt = secrets.token_hex(16)  # 32 hex chars
    dk = hashlib.pbkdf2_hmac(
        _PBKDF2_ALG,
        plain.encode("utf-8"),
        salt.encode("utf-8"),
        _PBKDF2_ITERATIONS,
    )
    return f"{salt}${dk.hex()}"


def verify_password(plain: str, stored: str) -> bool:
    """
    Compare a plaintext password against a stored "<salt>$<hash>" string.
    Returns True if they match, False otherwise.
    """
    try:
        salt, hex_hash = stored.split("$", 1)
    except ValueError:
        return False

    dk = hashlib.pbkdf2_hmac(
        _PBKDF2_ALG,
        plain.encode("utf-8"),
        salt.encode("utf-8"),
        _PBKDF2_ITERATIONS,
    )
    return hmac.compare_digest(dk.hex(), hex_hash)


# --- JWT helpers ---

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_MINUTES = int(os.getenv("JWT_EXPIRES_MINUTES", "1440"))  # default 1 day


def create_access_token(user_id: int) -> str:
    """
    Create a signed JWT that encodes the user id and expiry.
    """
    now = dt.datetime.utcnow()
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + dt.timedelta(minutes=JWT_EXPIRES_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> int:
    """
    Decode a JWT and return the user id (as int).
    Raises ValueError if the token is invalid or expired.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        sub = payload.get("sub")
        if sub is None:
            raise ValueError("Missing 'sub' in token")
        return int(sub)
    except Exception as e:
        raise ValueError("Invalid token") from e
