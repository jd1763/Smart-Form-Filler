# Simple Makefile for Smart Form Filler (no TABs needed)

.PHONY: up up-dev up-prod down build build-dev build-prod logs logs-dev logs-prod ps restart restart-dev restart-prod health kill8000

COMPOSE = docker compose

# ---- Dev is the default (hot reload, volumes bound) ----
up:          ; $(COMPOSE) up -d backend-dev
up-dev:      ; $(COMPOSE) up -d backend-dev
up-prod:     ; $(COMPOSE) up -d backend

down:        ; $(COMPOSE) down --remove-orphans

build:       ; $(COMPOSE) build backend-dev
build-dev:   ; $(COMPOSE) build backend-dev
build-prod:  ; $(COMPOSE) build backend

logs:        ; $(COMPOSE) logs -f --tail=100 backend-dev
logs-dev:    ; $(COMPOSE) logs -f --tail=100 backend-dev
logs-prod:   ; $(COMPOSE) logs -f --tail=100 backend

ps:          ; $(COMPOSE) ps

restart:     ; $(COMPOSE) down --remove-orphans && $(COMPOSE) up -d backend-dev
restart-dev: ; $(COMPOSE) down --remove-orphans && $(COMPOSE) up -d backend-dev
restart-prod:; $(COMPOSE) down --remove-orphans && $(COMPOSE) up -d backend

health:      ; (curl -sf http://127.0.0.1:5000/health || curl -sf http://localhost:8000/health) && echo "healthy" || (echo "backend not healthy" && exit 1)

# Free host port 8000 if some stray process is holding it
kill8000:    ; pids=$$(lsof -ti tcp:8000); if [ -n "$$pids" ]; then kill -9 $$pids; fi
