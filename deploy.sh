#!/bin/bash
set -e

# .env laden falls vorhanden (für DEPLOY_HOST etc.)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Args: [branch] <host>
# Erkennt ob erstes Argument ein Hostname (mit @) oder Branch ist,
# damit alter Aufruf ./deploy.sh user@host weiterhin funktioniert.
if [[ "$1" == *"@"* ]]; then
  HOST="$1"
  BRANCH="${2:-main}"
else
  BRANCH="${1:-main}"
  HOST="${2:-$DEPLOY_HOST}"
fi

if [ -z "$HOST" ]; then
  echo "Usage: ./deploy.sh [branch] [host]"
  echo ""
  echo "Examples:"
  echo "   ./deploy.sh elmarhepp                 # main branch"
  echo "   ./deploy.sh main elmarhepp             # bestimmter branch"
  echo "   ./deploy.sh feature-x elmarhepp        # feature branch"
  echo ""
  echo "Or set DEPLOY_HOST environment variable:"
  echo "   export DEPLOY_HOST=elmarhepp"
  echo "   ./deploy.sh                           # branch=main"
  echo "   ./deploy.sh feature-x                 # branch=feature-x"
  exit 1
fi

echo "🚀 Deploying Knora to $HOST (branch: $BRANCH) ..."

ssh "$HOST" "
  cd /var/www/knora && \
  git fetch origin && \
  git checkout '$BRANCH' && \
  git pull origin '$BRANCH' && \
  docker compose up -d --build
"

echo "✅ Deployed successfully!"
echo "   App:    https://knora.elmarhepp.de"
echo "   API:    https://knora.elmarhepp.de/api/v1/…  (das Frontend proxyt /api/ intern zu app:3000)"
echo "   Health: https://knora.elmarhepp.de/health"
