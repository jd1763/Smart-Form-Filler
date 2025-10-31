"""
My Flask API for Smart Form Filler
----------------------------------

This file runs a small web server that my Chrome extension will talk to.
It loads my trained ML model (`form_model.pkl`) and gives predictions
about what kind of form field a label is (ex: email, name, phone).

The extension sends a label -> this API sends back prediction + confidence.
"""

import datetime as dt
import glob
import json
import mimetypes
import os
import re
import sys  # helps build file paths
import uuid
from pathlib import Path

import joblib  # used to load my saved ML model
from docx import Document

# Flask basics for building APIs
from flask import Flask, abort, jsonify, request, send_file
from flask_cors import CORS  # lets my Chrome extension call this API without CORS errors

# --------- Text extractors ----------
from pdfminer.high_level import extract_text as pdf_extract_text
from sqlalchemy import Column, DateTime, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# === Import matchers ===
# - BaselineMatcher: TF-IDF + cosine similarity
# - MatcherEmbeddings: Sentence-BERT embeddings + semantic similarity
from ml.matcher_baseline import BaselineMatcher
from ml.matcher_embeddings import MatcherEmbeddings

from .matcher.resume_selector import select_best_resume

# Add the project root to Python path so we can import ml/ and backend/ modules
sys.path.append(os.path.dirname(os.path.dirname(__file__)))


def detect_mime(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    return mt or "application/octet-stream"


def extract_text_any(path: str) -> str:
    mime = detect_mime(path)
    if mime == "application/pdf":
        return pdf_extract_text(path) or ""
    if mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        doc = Document(path)
        return "\n".join(p.text for p in doc.paragraphs)
    raise ValueError(f"Unsupported file type: {mime}")


# === Path to the model file ===
# I keep my trained scikit-learn model in /models/form_model.pkl
# This builds a path that works no matter where the file is run from.
MODEL_PATH = os.path.join(
    os.path.dirname(__file__),  # start from backend/ folder
    "..",  # go up to project root
    "models",  # into models/ folder
    "form_model.pkl",  # the actual pickle file
)

# --------- App / DB setup ----------
BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT_NAME = os.getenv("SFF_STORAGE_DIR", "data")  # you renamed to "data"
STORAGE_DIR = BASE_DIR / STORAGE_ROOT_NAME
LEGACY_DIR = BASE_DIR / "uploads"  # keep compatibility with old uploads/

PDF_DIR = STORAGE_DIR / "resumes"
TEXT_DIR = STORAGE_DIR / "text"
for p in (STORAGE_DIR, PDF_DIR, TEXT_DIR):
    p.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR = STORAGE_DIR
DB_PATH = BASE_DIR / "db.sqlite3"
PROFILE_PATH = UPLOADS_DIR / "profile.json"
MAX_RESUMES = 5

# === Set up Flask app ===
app = Flask(__name__)
CORS(app)  # allow cross-origin requests (needed for Chrome extension -> API calls)

engine = create_engine(f"sqlite:///{DB_PATH}", future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

# === Load model once when the server starts ===
try:
    model = joblib.load(MODEL_PATH)
    print(f"=== Loaded model from {MODEL_PATH} ===")
except Exception as e:
    raise RuntimeError(f"=== Could not load model from {MODEL_PATH}: {e} ===")

# === Instantiate matchers ===
tfidf_matcher = BaselineMatcher()  # baseline TF-IDF matcher
try:
    embedding_matcher = MatcherEmbeddings()  # try to load embedding model
except Exception as e:
    # If embeddings fail to load (e.g. no GPU, missing package), fall back to TF-IDF only
    embedding_matcher = None
    print(f"[WARNING] Could not load embeddings matcher: {e}")


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(String, primary_key=True)  # uuid
    original_name = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    pdf_path = Column(String, nullable=False)  # original file path (pdf or docx)
    text_path = Column(String, nullable=False)  # extracted .txt path
    size_bytes = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=dt.datetime.utcnow)


Base.metadata.create_all(engine)

# A tiny whitelist; replace/expand from your real list if you have one.
# Combined + expanded whitelist of skills / technologies
SKILL_TERMS = [
    # --- Languages ---
    "python",
    "java",
    "javascript",
    "typescript",
    "c",
    "c++",
    "c#",
    "c sharp",
    "csharp",
    "go",
    "golang",
    "rust",
    "scala",
    "kotlin",
    "swift",
    "objective-c",
    "ruby",
    "php",
    "perl",
    "r",
    "dart",
    "matlab",
    "julia",
    "sql",
    "nosql",
    "no-sql",
    "bash",
    "zsh",
    "powershell",
    "html",
    "css",
    "scss",
    "sass",
    "less",
    # --- Frontend & Web ---
    "react",
    "react.js",
    "reactjs",
    "redux",
    "next.js",
    "nextjs",
    "angular",
    "angularjs",
    "vue",
    "vue.js",
    "vuejs",
    "svelte",
    "sveltekit",
    "tailwind",
    "tailwindcss",
    "bootstrap",
    "material ui",
    "mui",
    "chakra ui",
    "three.js",
    "d3",
    "chart.js",
    "storybook",
    "webpack",
    "vite",
    "rollup",
    "babel",
    "eslint",
    "prettier",
    # --- Backend & APIs ---
    "node",
    "node.js",
    "nodejs",
    "express",
    "express.js",
    "koa",
    "nest",
    "nest.js",
    "nestjs",
    "fastify",
    "hapi",
    "django",
    "flask",
    "fastapi",
    "tornado",
    "pyramid",
    "spring",
    "spring boot",
    "spring mvc",
    "hibernate",
    "quarkus",
    "micronaut",
    "asp.net",
    "asp.net core",
    ".net",
    ".net core",
    "dotnet",
    "laravel",
    "symfony",
    "codeigniter",
    "rails",
    "ruby on rails",
    "phoenix",
    "elixir",
    "gin",
    "fiber",
    "rest",
    "rest api",
    "graphql",
    "grpc",
    "soap",
    "websocket",
    "websockets",
    "openapi",
    "swagger",
    "asyncio",
    # --- Databases (SQL) ---
    "mysql",
    "mariadb",
    "postgres",
    "postgresql",
    "oracle",
    "sql server",
    "mssql",
    "sqlite",
    "aurora",
    "redshift",
    "snowflake",
    "bigquery",
    "synapse",
    "teradata",
    # --- Databases (NoSQL, search, cache, time series, graph) ---
    "mongodb",
    "dynamodb",
    "cassandra",
    "couchdb",
    "cosmos db",
    "neo4j",
    "arangodb",
    "janusgraph",
    "hbase",
    "elasticsearch",
    "opensearch",
    "solr",
    "redis",
    "memcached",
    "influxdb",
    "timescaledb",
    "prometheus",
    "questdb",
    # --- Data formats & serialization ---
    "parquet",
    "orc",
    "avro",
    "jsonl",
    "protobuf",
    "thrift",
    "csv",
    # --- Data/ETL/Streaming/Orchestration ---
    "spark",
    "hadoop",
    "yarn",
    "mapreduce",
    "hive",
    "pig",
    "presto",
    "trino",
    "flink",
    "beam",
    "airflow",
    "luigi",
    "prefect",
    "dbt",
    "kafka",
    "schema registry",
    "ksql",
    "pulsar",
    "kinesis",
    "pubsub",
    "pub/sub",
    "eventbridge",
    "sqs",
    "sns",
    "rabbitmq",
    "activemq",
    "nats",
    "zeromq",
    "celery",
    "sidekiq",
    # --- DevOps / CI-CD / Build ---
    "git",
    "github",
    "gitlab",
    "bitbucket",
    "svn",
    "ci",
    "cd",
    "ci/cd",
    "github actions",
    "gitlab ci",
    "circleci",
    "jenkins",
    "travis",
    "teamcity",
    "bamboo",
    "spinnaker",
    "argo",
    "argo cd",
    "argo workflows",
    "nexus",
    "jfrog",
    "artifactory",
    "sonarqube",
    "coveralls",
    "codecov",
    "maven",
    "gradle",
    "sbt",
    "ant",
    "make",
    "cmake",
    "nmake",
    "poetry",
    "pipenv",
    "virtualenv",
    "conda",
    "npm",
    "yarn",
    "pnpm",
    "pip",
    "twine",
    "tox",
    "ruff",
    "flake8",
    "black",
    "isort",
    "pylint",
    "mypy",
    "pre-commit",
    "shellcheck",
    # --- Containers / Orchestration / Networking ---
    "docker",
    "docker compose",
    "podman",
    "kubernetes",
    "k8s",
    "helm",
    "istio",
    "linkerd",
    "traefik",
    "haproxy",
    "nginx",
    "apache httpd",
    "apache",
    "caddy",
    "envoy",
    "consul",
    "vault",
    "nomad",
    "etcd",
    "zookeeper",
    # --- Cloud (AWS) ---
    "aws",
    "cloud",
    "iam",
    "ec2",
    "s3",
    "rds",
    "aurora",
    "efs",
    "ecr",
    "elb",
    "alb",
    "nlb",
    "vpc",
    "route 53",
    "cloudfront",
    "cloudwatch",
    "cloudtrail",
    "lambda",
    "api gateway",
    "step functions",
    "eventbridge",
    "sns",
    "sqs",
    "sagemaker",
    "athena",
    "glue",
    "emr",
    "kinesis",
    "eks",
    "ecs",
    "fargate",
    "elastic beanstalk",
    "batch",
    "lightsail",
    "secrets manager",
    "kms",
    "opensearch",
    # --- Cloud (GCP) ---
    "gcp",
    "compute engine",
    "cloud storage",
    "cloud sql",
    "bigquery",
    "spanner",
    "firestore",
    "datastore",
    "bigtable",
    "pub/sub",
    "dataflow",
    "dataproc",
    "composer",
    "gke",
    "cloud run",
    "cloud functions",
    "vertex ai",
    "cloud build",
    "artifact registry",
    "cloud logging",
    "cloud monitoring",
    "memorystore",
    "iam",
    # --- Cloud (Azure) ---
    "azure",
    "vm",
    "aks",
    "app service",
    "functions",
    "cosmos db",
    "sql database",
    "blob storage",
    "event hubs",
    "service bus",
    "synapse",
    "databricks",
    "data factory",
    "key vault",
    "monitor",
    "devops",
    "pipelines",
    "container registry",
    "application gateway",
    # --- Testing / QA ---
    "unit testing",
    "unittest",
    "pytest",
    "nose",
    "doctest",
    "junit",
    "testng",
    "mockito",
    "hamcrest",
    "kotest",
    "spock",
    "xunit",
    "mstest",
    "selenium",
    "cypress",
    "playwright",
    "puppeteer",
    "robot framework",
    "rest-assured",
    "supertest",
    "jest",
    "mocha",
    "chai",
    "ava",
    "vitest",
    "enzyme",
    "jasmine",
    "karma",
    "postman",
    "newman",
    "locust",
    "k6",
    "gatling",
    "jmeter",
    "tdd",
    "bdd",
    "property-based testing",
    "hypothesis",
    # --- Mobile ---
    "android",
    "android sdk",
    "jetpack",
    "jetpack compose",
    "gradle",
    "adb",
    "ios",
    "swiftui",
    "xcode",
    "cocoapods",
    "react native",
    "expo",
    "flutter",
    "ionic",
    "cordova",
    # --- Analytics / Viz ---
    "matplotlib",
    "seaborn",
    "plotly",
    "bokeh",
    "altair",
    "ggplot",
    "tableau",
    "looker",
    "lookml",
    "power bi",
    "superset",
    "metabase",
    "redash",
    "grafana",
    "kibana",
    "quicksight",
    # --- ML / AI / MLOps ---
    "machine learning",
    "ml",
    "deep learning",
    "dl",
    "scikit-learn",
    "sklearn",
    "pandas",
    "numpy",
    "scipy",
    "xgboost",
    "lightgbm",
    "catboost",
    "pytorch",
    "tensorflow",
    "tf",
    "keras",
    "pytorch lightning",
    "onnx",
    "mlflow",
    "huggingface",
    "transformers",
    "opencv",
    "nltk",
    "spacy",
    "gensim",
    "fairseq",
    "detectron",
    "yolo",
    "stable diffusion",
    "prophet",
    "statsmodels",
    "feature engineering",
    "model deployment",
    "model serving",
    "onnxruntime",
    "triton inference server",
    "kubeflow",
    "seldon",
    "bentoml",
    "ray",
    "ray serve",
    "feast",
    "tfx",
    "vertex ai",
    # --- Observability / Logging ---
    "prometheus",
    "loki",
    "tempo",
    "jaeger",
    "zipkin",
    "opentelemetry",
    "elastic stack",
    "elk",
    "logstash",
    "fluentd",
    "fluent-bit",
    "datadog",
    "new relic",
    "splunk",
    "sentry",
    "rollbar",
    "honeycomb",
    # --- Security & Auth ---
    "oauth",
    "oauth2",
    "openid connect",
    "oidc",
    "jwt",
    "saml",
    "mfa",
    "sso",
    "rbac",
    "abac",
    "tls",
    "ssl",
    "https",
    "ssh",
    "bcrypt",
    "argon2",
    "pbkdf2",
    "owasp",
    "cors",
    "csrf",
    "rate limiting",
    "waf",
    "zap",
    "burp suite",
    "keycloak",
    "okta",
    "auth0",
    "cognito",
    "kms",
    "secrets manager",
    "vault",
    # --- Architecture & CS topics ---
    "microservices",
    "event-driven",
    "domain-driven design",
    "ddd",
    "clean architecture",
    "hexagonal architecture",
    "cqrs",
    "event sourcing",
    "message queues",
    "caching",
    "cache",
    "webhooks",
    "serverless",
    "monolith",
    "soa",
    "design patterns",
    "data structures",
    "algorithms",
    "oop",
    "functional programming",
    "concurrency",
    "multithreading",
    "async",
    "synchronization",
    "transactions",
    "acid",
    "cap theorem",
    "eventual consistency",
    "distributed systems",
    # --- Workflow & misc tools ---
    "jira",
    "confluence",
    "notion",
    "slack",
    "microsoft teams",
    "excel",
    "gitflow",
    "semver",
]


# --- Helpers for /skills/by_resume ---
def get_resume_text_by_id(rid: str) -> str:
    """
    Return extracted text for resume <rid>, preferring backend/data/text/<id>.txt.
    If missing, try to repair via ensure_text_exists(...), otherwise extract from PDF
    in backend/data/resumes and persist to backend/data/text.
    """
    try:
        with SessionLocal() as s:
            r = s.get(Resume, str(rid))
            if not r:
                return ""

            # 1) Try DB path if present
            if getattr(r, "text_path", None):
                p = Path(r.text_path)
                if p.exists():
                    return p.read_text(encoding="utf-8")

            # 2) Canonical text location by ID
            txt_path = TEXT_DIR / f"{r.id}.txt"
            if txt_path.exists():
                # (optional) backfill DB
                try:
                    r.text_path = str(txt_path)
                    s.add(r)
                    s.commit()
                except Exception:
                    pass
                return txt_path.read_text(encoding="utf-8")

            # 3) If you have an existing helper, let it (re)create the text file
            try:
                # ensure_text_exists should return a Path or str to the text file
                out = ensure_text_exists(s, r)  # <-- use your existing function if present
                out_p = Path(out)
                if out_p.exists():
                    return out_p.read_text(encoding="utf-8")
            except Exception:
                pass

            # 4) Last resort: extract from PDF and persist
            pdf_candidates = []
            if getattr(r, "pdf_path", None):
                pdf_candidates.append(Path(r.pdf_path))
            pdf_candidates.append(PDF_DIR / f"{r.id}.pdf")

            text = ""
            for pdf in pdf_candidates:
                try:
                    if pdf and pdf.exists():
                        text = extract_text_any(str(pdf)) or ""  # use your existing extractor
                        if text:
                            break
                except Exception:
                    continue

            if text:
                try:
                    TEXT_DIR.mkdir(parents=True, exist_ok=True)
                    txt_path.write_text(text, encoding="utf-8")
                    # backfill DB for next time
                    try:
                        r.text_path = str(txt_path)
                        s.add(r)
                        s.commit()
                    except Exception:
                        pass
                except Exception:
                    pass
            return text
    except Exception:
        return ""


def get_resume_name_by_id(rid: str) -> str:
    """Human-readable file name for the resume from DB (fallback empty)."""
    try:
        with SessionLocal() as s:
            r = s.get(Resume, str(rid))
            return getattr(r, "original_name", "") or getattr(r, "file_name", "") or ""
    except Exception:
        return ""


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


def extract_skills_from_text(text: str):
    t = _normalize(text)
    hits = set()
    multi = [s for s in SKILL_TERMS if " " in s]
    single = [s for s in SKILL_TERMS if " " not in s]
    # exact substring for multi-word
    for m in multi:
        if m in t:
            hits.add(m)
    # token presence for single words
    tokens = set(re.split(r"[^a-z0-9\+#\.]+", t))
    for s in single:
        if s in tokens:
            hits.add(s)
    return sorted(hits)


def _find_pdf_for_id(rid: str):
    # Look in current root
    hits = glob.glob(str(PDF_DIR / f"{rid}.*"))
    if hits:
        return hits[0]
    # Look in legacy root
    hits = glob.glob(str(LEGACY_DIR / "resumes" / f"{rid}.*"))
    return hits[0] if hits else None


def _text_path_for_id(rid: str):
    return TEXT_DIR / f"{rid}.txt"


def ensure_text_exists(session, rec: Resume) -> str:
    """Return a valid text_path for this resume, repairing/migrating if needed."""
    # 1) if DB path exists, use it
    if rec.text_path and os.path.exists(rec.text_path):
        return rec.text_path

    # 2) if text exists in the new location, update DB
    new_txt = _text_path_for_id(rec.id)
    if new_txt.exists():
        rec.text_path = str(new_txt)
        session.add(rec)
        session.commit()
        return rec.text_path

    # 3) if we have the PDF/DOCX anywhere, re-extract and update DB
    pdf_path = (
        rec.pdf_path
        if (rec.pdf_path and os.path.exists(rec.pdf_path))
        else _find_pdf_for_id(rec.id)
    )
    if pdf_path and os.path.exists(pdf_path):
        try:
            txt = extract_text_any(pdf_path)
            new_txt.parent.mkdir(parents=True, exist_ok=True)
            with open(new_txt, "w", encoding="utf-8") as f:
                f.write(txt or "")
            rec.text_path = str(new_txt)
            # also repair pdf_path if it was in legacy location
            if rec.pdf_path != pdf_path:
                rec.pdf_path = str(pdf_path)
                rec.size_bytes = os.path.getsize(pdf_path)
            session.add(rec)
            session.commit()
            return rec.text_path
        except Exception as e:
            raise RuntimeError(f"Re-extract failed for {rec.id}: {e}")

    # 4) last resort: not recoverable
    raise FileNotFoundError(f"No text or PDF found for resume {rec.id}")


def to_dict(r: Resume):
    return {
        "id": r.id,
        "original_name": r.original_name,
        "mime_type": r.mime_type,
        "size_bytes": r.size_bytes,
        "created_at": r.created_at.isoformat() + "Z",
    }


def count_resumes(session):
    return session.query(Resume).count()


# --- Deep merge ---
def deep_merge(a: dict, b: dict) -> dict:
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep_merge(a[k], v)
        else:
            a[k] = v
    return a


@app.post("/skills/extract")
def skills_extract():
    """
    POST { "text": "<resume plain text>" } -> { "skills": [...] }
    Must return 200 even for empty text (tests expect that).
    """
    data = request.get_json(silent=True) or {}
    text = data.get("text", "") or ""
    skills = extract_skills_from_text(text)
    return jsonify({"skills": skills}), 200


@app.post("/skills/by_resume")
def skills_by_resume():
    """
    POST { "resumeId": "<id>" } -> { "id": "<id>", "name": "<name>", "skills": [...] }
    Tests monkeypatch api.get_resume_text_by_id / api.get_resume_name_by_id.
    We call those if present; otherwise we gracefully fall back.
    """
    data = request.get_json(silent=True) or {}
    rid = data.get("resumeId")
    if not rid:
        return jsonify({"error": "resumeId required"}), 400

    # Use monkeypatched helpers if present (pytest sets them on this module).
    try:
        text = get_resume_text_by_id(rid)  # provided by tests via monkeypatch
    except NameError:
        text = ""

    try:
        name = get_resume_name_by_id(rid)  # provided by tests via monkeypatch
    except NameError:
        name = ""

    skills = extract_skills_from_text(text or "")
    return jsonify({"id": rid, "name": name, "skills": skills}), 200


@app.get("/profile")
def get_profile():
    if not PROFILE_PATH.exists():
        # empty profile by default
        return jsonify({})
    try:
        with open(PROFILE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": f"Failed to read profile: {e}"}), 500


@app.post("/profile")
@app.put("/profile")
def save_profile():
    try:
        data = request.get_json(force=True, silent=True) or {}
    except Exception as e:
        return jsonify({"error": f"Bad JSON: {e}"}), 400

    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "updated_at": dt.datetime.utcnow().isoformat() + "Z"})
    except Exception as e:
        return jsonify({"error": f"Failed to write profile: {e}"}), 500


@app.route("/profile", methods=["PATCH"])
def patch_profile():
    # 1) parse patch body
    try:
        patch = request.get_json(force=True, silent=True) or {}
    except Exception as e:
        return jsonify({"error": f"Bad JSON: {e}"}), 400

    # 2) read current profile.json (empty if missing)
    try:
        existing = {}
        if PROFILE_PATH.exists():
            with open(PROFILE_PATH, "r", encoding="utf-8") as f:
                existing = json.load(f) or {}
    except Exception as e:
        return jsonify({"error": f"Failed to read profile: {e}"}), 500

    # 3) deep-merge + write
    merged = deep_merge(existing, patch)
    try:
        PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(PROFILE_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return jsonify({"error": f"Failed to write profile: {e}"}), 500

    return jsonify(merged)


# --------- List ----------
@app.get("/resumes")
def list_resumes():
    with SessionLocal() as s:
        items = [to_dict(r) for r in s.query(Resume).order_by(Resume.created_at.desc()).all()]
    return jsonify({"items": items, "max": MAX_RESUMES})


# --------- Upload ----------
@app.post("/resumes")
def upload_resume():
    # Enforce limit
    with SessionLocal() as s:
        if count_resumes(s) >= MAX_RESUMES:
            return (
                jsonify(
                    {
                        "error": (
                            f"Maximum of {MAX_RESUMES} resumes reached. "
                            "Delete one to upload another."
                        )
                    }
                ),
                400,
            )

    if "file" not in request.files:
        return jsonify({"error": "No file provided; expected form-data 'file'."}), 400
    f = request.files["file"]
    if not f or not f.filename:
        return jsonify({"error": "Empty file."}), 400

    # temp save to determine type
    tmp_id = str(uuid.uuid4())
    orig_ext = os.path.splitext(f.filename)[1].lower()
    tmp_path = PDF_DIR / f"{tmp_id}{orig_ext or ''}"
    f.save(tmp_path)

    try:
        # Prefer browser MIME, fall back to filename-based guess
        mime = f.mimetype or detect_mime(f.filename) or detect_mime(str(tmp_path))
        if mime not in (
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ):
            os.remove(tmp_path)
            return jsonify({"error": "Only PDF and DOCX are supported."}), 400

        # finalize name with extension
        if orig_ext not in [".pdf", ".docx"]:
            orig_ext = ".pdf" if mime == "application/pdf" else ".docx"

        rid = str(uuid.uuid4())
        final_pdf_path = PDF_DIR / f"{rid}{orig_ext}"
        os.rename(tmp_path, final_pdf_path)

        # extract text to .txt
        text_out = extract_text_any(str(final_pdf_path))
        text_path = TEXT_DIR / f"{rid}.txt"
        with open(text_path, "w", encoding="utf-8") as out:
            out.write(text_out)

        # record
        with SessionLocal() as s:
            rec = Resume(
                id=rid,
                original_name=f.filename,
                mime_type=mime,
                pdf_path=str(final_pdf_path),
                text_path=str(text_path),
                size_bytes=os.path.getsize(final_pdf_path),
            )
            s.add(rec)
            s.commit()

        return jsonify({"item": {"id": rid, "original_name": f.filename}}), 201

    except Exception as e:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return jsonify({"error": f"Failed to process file: {e}"}), 500


# --------- View original file (PDF/DOCX) ----------
@app.get("/resumes/<rid>/file")
def get_file(rid):
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            abort(404)
        # repair pdf_path if file was moved
        pdf_path = r.pdf_path
        if not (pdf_path and os.path.exists(pdf_path)):
            cand = _find_pdf_for_id(r.id)
            if cand:
                r.pdf_path = cand
                r.size_bytes = os.path.getsize(cand)
                s.add(r)
                s.commit()
                pdf_path = cand
        if not (pdf_path and os.path.exists(pdf_path)):
            abort(404)
        return send_file(pdf_path, as_attachment=False, download_name=r.original_name)


# --------- Get extracted text ----------
@app.get("/resumes/<rid>/text")
def get_text(rid):
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            abort(404)
        with open(r.text_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        return jsonify({"id": r.id, "text": content})


# --------- Delete ----------
@app.delete("/resumes/<rid>")
def delete_resume(rid):
    with SessionLocal() as s:
        r = s.get(Resume, rid)
        if not r:
            return jsonify({"error": "Not found"}), 404
        try:
            if os.path.exists(r.pdf_path):
                os.remove(r.pdf_path)
            if os.path.exists(r.text_path):
                os.remove(r.text_path)
        except Exception as e:
            return jsonify({"error": f"OS cleanup error: {e}"}), 500
        s.delete(r)
        s.commit()
    return jsonify({"ok": True})


@app.route("/select_resume", methods=["POST", "OPTIONS"])
def select_resume_api():
    if request.method == "OPTIONS":
        return ("", 204)
    jd = (request.json or {}).get("job_description", "") or ""
    # Build a list like your old JSON format, but from the DB
    items = []
    with SessionLocal() as s:
        for r in s.query(Resume).order_by(Resume.created_at.desc()).all():
            try:
                with open(r.text_path, "r", encoding="utf-8") as fh:
                    txt = fh.read()
                items.append({"id": r.id, "name": r.original_name, "text": txt})
            except Exception:
                continue
    # Reuse your existing selector
    best, ranking = select_best_resume(jd, items)
    return jsonify({"best": best, "ranking": ranking})


@app.route("/match", methods=["POST", "OPTIONS"])
def match():
    if request.method == "OPTIONS":
        return ("", 204)
    """
    Compare resume against job description.

    Input JSON:
        {
          "resume": "...",
          "job_description": "...",
          "method": "tfidf" | "embedding"   (optional, default = tfidf)
        }

    Output JSON:
        {
          "similarity_score": 0.61,                     # similarity score
          "missing_keywords": [["aws", 0.48], ...],     # skills from JD missing in resume
          "method": "tfidf"                             # which matcher was used
        }
    """
    data = request.get_json()

    # Validate input
    if not data or "job_description" not in data:
        return jsonify({"error": "job_description is required"}), 400

    jd_text = data["job_description"]
    resume_text = (data.get("resume") or "").strip()
    rid = data.get("resume_id")

    # If caller didn’t send raw text, allow resume_id
    if not resume_text and rid:
        with SessionLocal() as s:
            r = s.get(Resume, rid)
            if not r:
                return jsonify({"error": "Resume not found"}), 404
            try:
                txt_path = ensure_text_exists(s, r)  # <- repair/migrate if needed
                with open(txt_path, "r", encoding="utf-8") as fh:
                    resume_text = fh.read()
            except FileNotFoundError as e:
                return jsonify({"error": str(e)}), 404
            except Exception as e:
                return jsonify({"error": f"Failed to load resume text: {e}"}), 500

    if not resume_text:
        return jsonify({"error": "resume (text) or resume_id is required"}), 400

    # Choose method (tfidf or embedding)
    method = data.get("method", "tfidf").lower()

    # === Embeddings Matcher ===
    if method == "embedding" and embedding_matcher:
        result = embedding_matcher.match_resume_job(resume_text, jd_text)
        return jsonify(
            {
                "similarity_score": round(float(result["match_score"]), 3),
                "missing_keywords": result["missing_skills"],
                "method": "embedding",
            }
        )

    # === TF-IDF Baseline Matcher (default) ===
    similarity, missing_keywords = tfidf_matcher.get_similarity_and_missing(resume_text, jd_text)

    return jsonify(
        {
            "similarity_score": round(float(similarity), 3),
            "missing_keywords": missing_keywords,
            "method": "tfidf",
        }
    )


# === Health check endpoint ===
@app.route("/health", methods=["GET"])
def health():
    """
    Simple check to see if the server is running.
    If I visit http://127.0.0.1:5000/health
    I should see: { "ok": true }
    """
    return jsonify({"ok": True})


# === Single prediction endpoint ===
@app.route("/predict", methods=["POST", "OPTIONS"])
def predict():
    if request.method == "OPTIONS":
        return ("", 204)
    """
    Input (from extension):
        { "label": "Email Address" }

    What happens:
    - Extract the label text from the JSON
    - Pass it into the ML model
    - Model predicts the field type (like "email", "name", etc.)
    - Also return a confidence score (how sure the model is)

    Output:
        {
          "label": "Email Address",
          "prediction": "email",
          "confidence": 0.91
        }
    """
    payload = request.get_json(force=True, silent=True) or {}
    text = payload.get("label", "")

    # Handle empty input
    if not text.strip():
        return jsonify({"error": "empty label"}), 400

    # Model makes prediction
    prediction = model.predict([text])[0]

    # If model supports probabilities, grab the highest one
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba([text])[0]
        confidence = float(max(probs))
    else:
        confidence = 1.0  # fallback if model doesn’t support probabilities

    return jsonify(
        {
            "label": text,
            "prediction": prediction,
            "confidence": round(confidence, 3),  # round for readability
        }
    )


# === Batch prediction endpoint ===
@app.route("/predict_batch", methods=["POST", "OPTIONS"])
def predict_batch():
    if request.method == "OPTIONS":
        return ("", 204)
    """
    Input:
        { "labels": ["First Name", "Phone Number"] }

    What happens:
    - Loop through each label
    - Predict field type + confidence
    - Collect all results in a list

    Output:
        [
          {"label": "First Name", "prediction": "name", "confidence": 0.87},
          {"label": "Phone Number", "prediction": "phone", "confidence": 0.76}
        ]
    """
    data = request.get_json(force=True, silent=True) or {}
    labels = data.get("labels", [])

    # Must be a list of strings
    if not isinstance(labels, list):
        return jsonify({"error": "labels must be a list"}), 400

    results = []
    for text in labels:
        if not text.strip():
            results.append({"label": text, "prediction": None, "confidence": 0})
            continue

        pred = model.predict([text])[0]

        if hasattr(model, "predict_proba"):
            probs = model.predict_proba([text])[0]
            conf = float(max(probs))
        else:
            conf = 1.0

        results.append({"label": text, "prediction": str(pred), "confidence": round(conf, 3)})

    return jsonify(results)


# === Run the server ===
if __name__ == "__main__":
    # Starts the Flask server at http://127.0.0.1:5000/
    # host=127.0.0.1 means it only runs locally (safe for dev)
    app.run(host="127.0.0.1", port=5000)
