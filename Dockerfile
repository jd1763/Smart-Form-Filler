# syntax=docker/dockerfile:1.7-labs

# I’m going slim to keep the image small but still compatible with sklearn/torch wheels.
FROM python:3.11-slim

# I’m only installing what I actually need at runtime.
# libgomp1 provides OpenMP used by sklearn; ca-certificates for HTTPS; curl for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# I like explicit, predictable Python behavior in containers.
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1 
# I’ll default to “production”; I can override to “development” when I want hot-reload.
ENV APP_ENV=production 
# If something points to PORT, this keeps it consistent.
ENV PORT=8000
ENV PIP_DEFAULT_TIMEOUT=120

# I want the entire repo at /app so "python -m backend.api" works without hacks.
WORKDIR /app

# --- deps first for cache ---
# my root requirements.txt includes: "-r backend/requirements.txt"
# so I copy BOTH before installing to avoid the "file not found" error.
COPY requirements.txt /app/requirements.txt
COPY backend/requirements.txt /app/backend/requirements.txt

# Use Docker BuildKit cache so subsequent builds reuse wheels
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --upgrade pip && \
    pip install -r /app/requirements.txt

# copy code needed at runtime
COPY backend /app/backend
COPY ml /app/ml
COPY matcher /app/matcher
COPY models /app/models   

# Make sure Python can import from /app and /app/backend 
ENV PYTHONPATH="/app:/app/backend"

# expose the prod port (Gunicorn)
EXPOSE 8000

# I run the Flask app via Gunicorn in prod. Module path matches backend/api.py (app = Flask(...))
CMD ["sh", "-c", "gunicorn backend.api:app -b 0.0.0.0:${PORT} --workers=2 --threads=4 --timeout=120"]
