BUN := $(shell command -v bun 2>/dev/null || echo ~/.bun/bin/bun)

.PHONY: help install build start stop restart migrate seed

help: ## 📖 Zeigt diese Hilfe an
	@echo ""
	@echo "╔══════════════════════════════════════╗"
	@echo "║           Knora — Makefile           ║"
	@echo "╚══════════════════════════════════════╝"
	@echo ""
	@echo "  make install    Alle Abhängigkeiten installieren"
	@echo "  make build      Backend + Frontend bauen"
	@echo "  make start      DB + Backend + Frontend starten (Hot-Reload)"
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
	@if lsof -t -i:3000 >/dev/null 2>&1; then \
		echo "⚠️  Backend läuft bereits auf Port 3000 (überspringe)"; \
	else \
		echo "🔥 Starte Backend (Port 3000)..."; \
		cd backend && $(BUN) run dev & \
		sleep 2; \
	fi
	@echo ""
	@if lsof -t -i:5173 >/dev/null 2>&1; then \
		echo "⚠️  Frontend läuft bereits auf Port 5173 (überspringe)"; \
	else \
		echo "💻 Starte Frontend (Port 5173)..."; \
		cd frontend && $(BUN) run dev; \
	fi

stop: ## 🛑 Alles stoppen (Prozesse + DB)
	@echo "🛑 Beende Backend (Port 3000)..."
	@lsof -t -i:3000 2>/dev/null | xargs kill -9 2>/dev/null || echo "   Kein Prozess auf Port 3000"
	@echo "🛑 Beende Frontend (Port 5173)..."
	@lsof -t -i:5173 2>/dev/null | xargs kill -9 2>/dev/null || echo "   Kein Prozess auf Port 5173"
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
