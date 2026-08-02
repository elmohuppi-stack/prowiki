FROM oven/bun:1 AS builder
WORKDIR /app

# Root-Workspace + Frontend-Stub (nötig damit Workspace-Auflösung klappt)
COPY package.json bun.lock ./
RUN mkdir -p frontend && echo '{"name":"frontend-stub"}' > frontend/package.json
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src

# Backend-Dependencies (vom Root aus installieren, Workspaces werden aufgelöst)
COPY backend/package.json backend/tsconfig.json ./backend/
RUN bun install

# Build
COPY backend/src ./backend/src
RUN bun build ./backend/src/index.ts --outdir ./backend/dist --target bun

# ---------------------------------------------------------------------------
# Werkzeug-Image: führt die Skripte unter backend/src/scripts aus
#
# Das Runtime-Image unten enthält bewusst nur das gebündelte dist/index.js und
# ist damit klein – aber Skripte laufen dort nicht: `bun install` legt die
# Abhängigkeiten wegen der Workspace-Auflösung unter /app/backend/node_modules
# ab, nicht unter /app/node_modules. Die App merkt das nicht (ihr Bundle hat
# alles eingebacken), ein Skript scheitert aber sofort mit
# "Cannot find package 'drizzle-orm'".
#
# Dieses Stage behebt das für Wartungsläufe (Import, Embeddings, Wiki-Läufe,
# Migrationen) – ohne das Runtime-Image zu vergrößern. Gestartet wird es über
# das Compose-Profil "tools", läuft also nie im Normalbetrieb mit:
#
#   docker compose --profile tools build tools
#   docker compose --profile tools run --rm tools \
#     bun run src/scripts/rki-wiki-run.ts --workspace <id> --depth summary
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS tools
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/backend/package.json /app/backend/tsconfig.json ./backend/
# Quellen und Migrationen direkt aus dem Kontext: die Skripte werden zur
# Laufzeit gelesen, nicht gebündelt.
COPY backend/src ./backend/src
COPY backend/drizzle ./backend/drizzle
COPY backend/drizzle.config.ts ./backend/
WORKDIR /app/backend
CMD ["bun", "--eval", "console.log('Werkzeug-Image. Beispiel: bun run src/scripts/verify-rki.ts --workspace <id>')"]

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/backend/dist ./dist
# node_modules liegt im Root (wegen Workspace-Install von dort)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
EXPOSE 3000
# Die Dist-Datei ist ein Standalone-Bundle, einfach ausführen
CMD ["bun", "run", "dist/index.js"]
