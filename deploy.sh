#!/bin/bash
set -euo pipefail

# Deploy prowiki.
#
# ACHTUNG: Dieses Skript stammt aus knora und zeigte dort auf /var/www/knora.
# Unverändert übernommen hätte es prowiki in knoras Verzeichnis deployt und dort
# einen fremden Branch ausgecheckt. Der Zielpfad hängt deshalb am APP_SLUG und
# wird vor jedem Lauf gegengeprüft.
#
# Voraussetzungen auf dem Server (siehe platform/ARCHITEKTUR.md 11):
#   - /var/www/prowiki ist ein Git-Checkout dieses Repos
#   - .env liegt dort mit Mode 600
#   - Datenbank + unprivilegierte Rolle sind angelegt
#   - nginx-Vhost in sites-available UND Symlink in sites-enabled
#   - Portblock 3121/3122 ist vergeben (3101/3102 gehören wandervogel)
#
# Der vollständige Ablauf der ersten Live-Schaltung steht in docs/LIVEGANG.md.

APP_SLUG="${APP_SLUG:-prowiki}"
REMOTE_DIR="/var/www/${APP_SLUG}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ "${1:-}" == *"@"* ]]; then
  HOST="$1"
  BRANCH="${2:-main}"
else
  BRANCH="${1:-main}"
  HOST="${2:-${DEPLOY_HOST:-}}"
fi

if [ -z "${HOST:-}" ]; then
  cat <<'USAGE'
Usage: ./deploy.sh [branch] [host]

  ./deploy.sh elmarhepp              # main
  ./deploy.sh main elmarhepp         # bestimmter Branch
  ./deploy.sh feature-x elmarhepp

Oder DEPLOY_HOST setzen:
  export DEPLOY_HOST=elmarhepp
USAGE
  exit 1
fi

echo "🚀 prowiki → $HOST:$REMOTE_DIR (Branch: $BRANCH)"

# Sicherung gegen genau den Fehler, den die knora-Fassung dieses Skripts
# ermöglicht hätte: ins falsche Verzeichnis deployen.
ssh "$HOST" "test -d '$REMOTE_DIR/.git'" || {
  echo "❌ $REMOTE_DIR ist kein Git-Checkout — Abbruch." >&2
  exit 1
}

REMOTE_ORIGIN=$(ssh "$HOST" "git -C '$REMOTE_DIR' remote get-url origin")
case "$REMOTE_ORIGIN" in
  *prowiki*) ;;
  *)
    echo "❌ $REMOTE_DIR zeigt auf '$REMOTE_ORIGIN', nicht auf prowiki — Abbruch." >&2
    exit 1
    ;;
esac

# Anti-Pattern aus ARCHITEKTUR.md 12: ein Compose-Stand mit eigenem Postgres
# würde einen zweiten Postmaster auf einem fremden Datenverzeichnis starten.
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  git fetch origin
  git checkout '$BRANCH'
  git pull origin '$BRANCH'
  if grep -qE 'image: (pgvector|postgres)' docker-compose.yml; then
    echo '❌ docker-compose.yml enthält einen eigenen Postgres-Service — Abbruch.' >&2
    exit 1
  fi
  docker compose up -d --build
"

echo "✅ Deployt. Prüfen:"
echo "   ssh $HOST 'docker compose --project-directory $REMOTE_DIR ps'"
echo "   curl -s https://${APP_SLUG}.elmarhepp.de/health"
echo
# Seit dem 21. August tragen laufende Importe einen Neustart. Vorher hingen sie
# als setTimeout im API-Prozess, und genau dieses `up --build` oben verlor sie
# still — ohne Fehler, ohne Log, das Dokument blieb auf "processing" stehen.
# Der Blick in die Warteschlange sagt, ob der Worker sie aufgenommen hat.
echo "   Warteschlange (offene Jobs, sollte nach kurzer Zeit leer sein):"
echo "   ssh $HOST 'docker exec pg-shared psql -U ${DB_USER:-prowiki} -d ${DB_NAME:-prowiki} \\"
echo "     -c \"select name, state, count(*) from pgboss.job group by 1,2 order by 1,2\"'"
