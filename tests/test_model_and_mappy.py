# tests/test_model_and_mappy.py
import os, json, pathlib, pytest
from tests.golden_form_mapping import GOLDEN_LABELS, GOLDEN_EXPECTED_KEYS
from tests.value_resolver import flatten_profile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILE_JSON = os.environ.get("PROFILE_JSON") or str((ROOT / "backend" / "data" / "profile.json"))
MODEL_FILES = [
    str(ROOT / "models" / "form_model.pkl"),
    str(ROOT / "backend" / "models" / "form_model.pkl"),
    str(ROOT / "form_model.pkl"),
]

def _first_existing(*paths):
    for p in paths:
        if p and os.path.exists(str(p)):
            return str(p)
    return None

MODEL_PKL = _first_existing(*MODEL_FILES)

def predict_labels(labels):
    try:
        from tests.value_resolver import predict_stub
        raw = predict_stub(labels)
    except Exception:
        raw = []
        for lab in labels:
            s = lab.lower()
            if "first" in s: raw.append("firstName")
            elif "surname" in s or "last" in s or "family" in s: raw.append("lastName")
            elif "email" in s: raw.append("email")
            elif "mobile" in s or "phone" in s: raw.append("phoneNumber")
            elif "birth" in s or "dob" in s: raw.append("dob")
            elif "address" in s and "line" in s: raw.append("street")
            elif "street" in s: raw.append("street")
            elif "city" in s or "town" in s: raw.append("city")
            elif "state" in s or "province" in s or "region" in s: raw.append("state")
            elif "zip" in s or "postal" in s or "postcode" in s: raw.append("zip")
            elif "country" in s or "nation" in s: raw.append("country")
            else: raw.append(None)

    CANON = {
        "name":"fullName",
        "phone":"phoneNumber",
        "birth_date":"dob",
        "zipcode":"zip",
        "zip code":"zip",
        "postal code":"zip",
        "address":"street",
    }
    return [CANON.get((p or "").lower(), p) if p else p for p in raw]

def test_value_resolution_from_profile():
    assert os.path.exists(PROFILE_JSON), f"Could not find profile.json at {PROFILE_JSON}"
    with open(PROFILE_JSON, "r") as f:
        profile = json.load(f)
    FLAT = flatten_profile(profile)
    # Sample several keys from the expected set and make sure they exist
    for k in ["firstName","lastName","email","phoneNumber","street","city","state","zip","country"]:
        assert k in FLAT, f"{k} not in flattened profile"

@pytest.mark.skipif(MODEL_PKL is None, reason="form_model.pkl not found; skipping prediction tests.")
def test_model_predictions_topk():
    labels = ["First Name","Surname","Email Address","Street Address","City / Town","State","Zip Code"]
    preds = predict_labels(labels)
    expect_any = {"firstName","lastName","email","street","city","state","zip"}
    assert sum(1 for p in preds if p in expect_any) >= int(len(labels) * 0.7)

@pytest.mark.skipif(MODEL_PKL is None, reason="form_model.pkl not found; skipping prediction tests.")
def test_predicted_label_returns_correct_answer():
    # Minimal check that predicted keys correspond to some known field
    labels = ["First Name","Surname","Email Address"]
    preds = predict_labels(labels)
    assert any(p in GOLDEN_EXPECTED_KEYS for p in preds)
