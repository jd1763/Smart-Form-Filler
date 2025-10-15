# tests/conftest.py
import pathlib, joblib, pytest
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

MODEL = pathlib.Path(__file__).resolve().parents[1] / "models" / "form_model.pkl"

def pytest_sessionstart(session):
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    need_build = True
    if MODEL.exists():
        try:
            joblib.load(MODEL)
            need_build = False
        except Exception:
            need_build = True

    if need_build:
        # Minimal, but covers the labels your tests expect
        X = [
            "first name", "last name", "full name", "email address", "mobile phone",
            "street address", "city", "state or province", "zip code or postal code",
            "date of birth", "gender", "linkedin url", "github url", "company", "job title"
        ]
        y = [
            "first_name","last_name","name","email","phone",
            "street","city","state","zip",
            "dob","gender","linkedin","github","company","job_title"
        ]
        pipe = Pipeline([
            ("tfidf", TfidfVectorizer(ngram_range=(1,2), min_df=1)),
            ("clf", LogisticRegression(max_iter=1000))
        ])
        pipe.fit(X, y)
        joblib.dump(pipe, MODEL)

@pytest.fixture(scope="session")
def profile_path():
    env = os.getenv("PROFILE_JSON")
    if env:
        p = pathlib.Path(env)
        if not p.exists():
            pytest.skip(f"PROFILE_JSON not found: {p}")
        return p
    p = _first_existing([
        "backend/data/profile.json",
        "data/profile.json",
        "profile.json",
    ])
    if not p:
        pytest.skip("Could not find profile.json (set $PROFILE_JSON or place in backend/data/)")
    return p

@pytest.fixture(scope="session")
def profile(profile_path):
    return json.loads(profile_path.read_text(encoding="utf-8"))

@pytest.fixture(scope="session")
def model_path():
    env = os.getenv("FORM_MODEL_PKL")
    if env:
        p = pathlib.Path(env)
        if p.exists():
            return p
    p = _first_existing([
        "form_model.pkl",
        "models/form_model.pkl",
        "backend/models/form_model.pkl",
    ])
    return p

@pytest.fixture(scope="session")
def model(model_path):
    if not model_path:
        pytest.skip("form_model.pkl not found; skipping prediction tests.")
    try:
        with open(model_path, "rb") as f:
            return pickle.load(f)
    except Exception as e:
        pytest.skip(f"Could not load model from {model_path}: {e}")

@pytest.fixture(scope="session")
def bs4():
    try:
        import bs4  # noqa: F401
        return True
    except Exception:
        pytest.skip("BeautifulSoup (bs4) not installed; run: pip install bs4 lxml")

@pytest.fixture(scope="session")
def form_html_path():
    env = os.getenv("FORM_HTML")
    if env:
        p = pathlib.Path(env)
        if p.exists():
            return p
    p = _first_existing([
        "form-test.html",
        "tests/fixtures/form-test.html",
        "demo/form-test.html",
    ])
    return p

@pytest.fixture(scope="session")
def form_dom(form_html_path, bs4):
    if not form_html_path:
        pytest.skip("form-test.html not found; set $FORM_HTML if needed.")
    from bs4 import BeautifulSoup
    html = form_html_path.read_text(encoding="utf-8")
    return BeautifulSoup(html, "lxml")
