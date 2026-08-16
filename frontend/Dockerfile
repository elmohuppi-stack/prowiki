# Baut aus dem **Repo-Wurzelverzeichnis**, nicht aus ./frontend:
#
#   docker build -f frontend/Dockerfile .
#
# Der Grund steht in docs/LIVEGANG.md 2.1. Kurz: frontend/package.json hängt an
# `"@prowiki/shared": "workspace:*"` (die Capability-Definition, die Frontend und
# Backend teilen müssen, damit die Oberfläche keinen Knopf anbietet, den das
# Backend mit 403 ablehnt). Ein `npm install` im Verzeichnis frontend/ kennt
# keine Workspace-Wurzel und bricht ab:
#
#   npm error code EUNSUPPORTEDPROTOCOL
#   npm error Unsupported URL Type "workspace:": workspace:*
#
# Deshalb derselbe Aufbau wie in backend/Dockerfile: Wurzel-Manifest plus
# packages/shared kopieren, mit Bun installieren (versteht das
# workspace:-Protokoll), erst danach die Quellen.
FROM oven/bun:1 AS builder
WORKDIR /app

# Wurzel-Workspace + Backend-Stub (nötig, damit die Workspace-Auflösung aufgeht,
# ohne die Backend-Abhängigkeiten mitzuinstallieren)
COPY package.json bun.lock ./
RUN mkdir -p backend && echo '{"name":"backend-stub"}' > backend/package.json
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src

COPY frontend/package.json ./frontend/
RUN bun install

# Quellen zuletzt: so bleibt die Installationsschicht über Änderungen am Code
# hinweg im Cache.
# env.d.ts nicht vergessen: sie deklariert `*.vue` und `import.meta.env`. Fehlt
# sie, scheitert vue-tsc mit 23 Fehlern, die alle so aussehen, als wären die
# Dateien nicht da ("Cannot find module './App.vue'").
COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html frontend/env.d.ts ./frontend/
COPY frontend/src ./frontend/src

WORKDIR /app/frontend
# `bun run build` führt vue-tsc --noEmit vor vite build aus. Der Typfehler soll
# den Build anhalten, nicht in Produktion auffallen.
RUN bun run build

FROM nginx:stable-alpine
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
