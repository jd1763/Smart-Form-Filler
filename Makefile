# Simple Makefile for Smart Form Filler

.PHONY: up up-dev up-prod down \
        build build-dev build-prod \
        logs logs-dev logs-prod \
        ps restart restart-dev restart-prod \
        health kill8000 kill8001 \
        run-local run-local-v1 run-local-v2

COMPOSE = docker compose

# ==========================
# Docker (dev: hot reload)
# ==========================

# Bring up BOTH v1 (Flask) and v2 (FastAPI) dev containers
up:          ; $(COMPOSE) up -d backend-dev backend-v2-dev
up-dev:      ; $(COMPOSE) up -d backend-dev backend-v2-dev

# Prod: bring up BOTH v1 and v2 prod containers
up-prod:     ; $(COMPOSE) up -d backend backend-v2

down:        ; $(COMPOSE) down --remove-orphans

# Build images
build:       ; $(COMPOSE) build backend-dev backend-v2-dev
build-dev:   ; $(COMPOSE) build backend-dev backend-v2-dev
build-prod:  ; $(COMPOSE) build backend backend-v2

# Logs (dev by default)
logs:        ; $(COMPOSE) logs -f --tail=100 backend-dev backend-v2-dev
logs-dev:    ; $(COMPOSE) logs -f --tail=100 backend-dev backend-v2-dev
logs-prod:   ; $(COMPOSE) logs -f --tail=100 backend backend-v2

ps:          ; $(COMPOSE) ps

restart:     ; $(COMPOSE) down --remove-orphans && $(COMPOSE) up -d backend-dev backend-v2-dev
restart-dev: ; $(COMPOSE) down --remove-orphans && $(COMPOSE) up -d backend-dev backend-v2-dev
restart-prod:; $(COMPOSE) down --remove-orphans && $(COMPOSE) up -d backend backend-v2

# Simple health check for Docker dev: both ports must respond
health:      ; (curl -sf http://127.0.0.1:8000/health && curl -sf http://127.0.0.1:8001/health) && echo "healthy" || (echo "backend not healthy" && exit 1)

kill8000:    ; pids=$$(lsof -ti tcp:8000 2>/dev/null || true); if [ -n "$$pids" ]; then kill $$pids; fi
kill8001:    ; pids=$$(lsof -ti tcp:8001 2>/dev/null || true); if [ -n "$$pids" ]; then kill $$pids; fi

# ==========================
# Local dev (Python)
# ==========================

# Run BOTH v1 and v2 locally via Python
run-local:
	./scripts/run_local_backends.sh

# Optional helpers if you ever want to run just one:
run-local-v1:
	python -m backend.api

run-local-v2:
	python -m backend.fastapi_app
