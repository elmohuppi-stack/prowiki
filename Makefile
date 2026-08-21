BUN := $(shell command -v bun 2>/dev/null || echo ~/.bun/bin/bun)

# Der Backend-Port kommt aus der .env, nicht aus einer festen Zahl.
#
# Vorher stand hier überall 3000, während die .env `PORT=3102` setzt. Die Folge
# war kein Fehler, sondern etwas Schlimmeres: `make start` prüfte Port 3000, hielt
# das Backend für nicht laufend und startete **jedes Mal einen weiteren** — am
# 21. August 2026 waren fünf `bun run --watch src/index.ts` gleichzeitig offen.
# `make stop` tötete dabei nichts, weil es ebenfalls auf 3000 sah. Genau davor
# warnt .instructions.md ("Do NOT stack multiple bun run"), und die Vorlage dafür
# stand im Makefile selbst.
BACKEND_PORT := $(or $(shell grep -sE '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d ' "'),3000)
FRONTEND_DEV_PORT := 5173

.PHONY: help install build start stop restart migrate seed

help: ## 📖 Zeigt diese Hilfe an
	@echo ""
	@echo "╔══════════════════════════════════════╗"
	@echo "║           Knora — Makefile           ║"
	@echo "╚══════════════════════════════════════╝"
	@echo ""
	@echo "  make install    Alle Abhängigkeiten installieren"
	@echo "  make build      Backend + Frontend bauen"
	@echo "  make start      DB + Backend + Worker + Frontend starten (Hot-Reload)"
	@echo "  make stop       Alles stoppen (Prozesse + DB)"
	@echo "  make restart    Neustart (stop + start)"
	@echo ""
	@echo "  make migrate    DB-Migration ausführen"
	@echo "  make seed       DB mit Admin-User seeden"
	@echo ""

install: ## 📦 Alle Abhängigkeiten installieren
	@echo "📦 Installiere Abhängigkeiten..."
	cd packages/shared && $(BUN) install
	cd backend && $(BUN) install
	cd frontend && $(BUN) install
	$(BUN) install
	@echo "✅ Fertig!"

build: ## 🔨 Backend + Frontend bauen
	@echo "🔨 Baue Backend..."
	cd backend && $(BUN) run build
	@echo "🔨 Baue Frontend..."
	cd frontend && $(BUN) run build
	@echo "✅ Build abgeschlossen!"

start: ## 🚀 DB + Backend + Frontend starten (Hot-Reload)
	@echo "🚀 Starte PostgreSQL..."
	@docker compose -f docker-compose.dev.yml up -d db
	@echo ""
	@if lsof -t -i:$(BACKEND_PORT) >/dev/null 2>&1; then \
		echo "⚠️  Backend läuft bereits auf Port $(BACKEND_PORT) (überspringe)"; \
	else \
		echo "🔥 Starte Backend (Port $(BACKEND_PORT))..."; \
		cd backend && $(BUN) run dev & \
		sleep 2; \
	fi
	@echo ""
	@# Der Worker arbeitet die Job-Warteschlange ab (backend/src/jobs). Ohne ihn
	@# bleibt lokal jeder Import auf "processing" stehen — die API stellt nur
	@# noch ein und verarbeitet nichts mehr selbst.
	@if pgrep -f "jobs/worker.ts" >/dev/null 2>&1; then \
		echo "⚠️  Worker läuft bereits (überspringe)"; \
	else \
		echo "⚙️  Starte Worker..."; \
		cd backend && $(BUN) run worker:dev & \
		sleep 1; \
	fi
	@echo ""
	@if lsof -t -i:$(FRONTEND_DEV_PORT) >/dev/null 2>&1; then \
		echo "⚠️  Frontend läuft bereits auf Port $(FRONTEND_DEV_PORT) (überspringe)"; \
	else \
		echo "💻 Starte Frontend (Port $(FRONTEND_DEV_PORT))..."; \
		cd frontend && $(BUN) run dev; \
	fi

stop: ## 🛑 Alles stoppen (Prozesse + DB)
	@echo "🛑 Beende Backend (Port $(BACKEND_PORT))..."
	@lsof -t -i:$(BACKEND_PORT) 2>/dev/null | xargs kill -9 2>/dev/null || echo "   Kein Prozess auf Port $(BACKEND_PORT)"
	@# Zusätzlich über den Prozessnamen: ein gestapelter Watch-Prozess, der den
	@# Port nicht bekommen hat, lauscht auf nichts und wäre über lsof unsichtbar —
	@# neu laden tut er trotzdem und schreibt dabei in die Datenbank.
	@pkill -f "watch src/index.ts" 2>/dev/null && echo "   Zusätzliche Watch-Prozesse beendet" || true
	@echo "🛑 Beende Worker..."
	@pkill -f "jobs/worker.ts" 2>/dev/null || echo "   Kein Worker-Prozess"
	@echo "🛑 Beende Frontend (Port $(FRONTEND_DEV_PORT))..."
	@lsof -t -i:$(FRONTEND_DEV_PORT) 2>/dev/null | xargs kill -9 2>/dev/null || echo "   Kein Prozess auf Port $(FRONTEND_DEV_PORT)"
	@echo "🛑 Stoppe PostgreSQL..."
	@docker compose -f docker-compose.dev.yml down
	@echo "✅ Alles gestoppt"

restart: stop start ## 🔄 Neustart (stop + start)

migrate: ## 🗄️ DB-Migration ausführen
	@echo "🗄️ Führe Migration aus..."
	cd backend && $(BUN) run db:migrate
	@echo "✅ Migration ausgeführt!"

seed: ## 🌱 DB mit Admin-User seeden
	@echo "🌱 Seede Datenbank..."
	cd backend && $(BUN) run db:seed
	@echo "✅ Seed abgeschlossen!"
