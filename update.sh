#!/bin/bash
set -e

# .env and docker-compose.yml live next to this script: always run from here.
cd "$(dirname "$0")"

echo "╔══════════════════════════════════════╗"
echo "║   BlackVault — Update Script         ║"
echo "╚══════════════════════════════════════╝"
echo ""

# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh

# ── Docker Compose v2.20+ ─────────────────────────────────────
# docker-compose.yml needs it. Exits before anything is touched (no .env
# change, no git pull, no rebuild) when it is missing or older, so the
# running BlackVault keeps running.
require_compose

# ── Migrate .blackvault.env → .env ────────────────────────────
if [ ! -f ".env" ] && [ -f ".blackvault.env" ]; then
  echo "Migrating .blackvault.env to .env (one-time)..."
  cp .blackvault.env .env
  echo "Done. .blackvault.env kept as backup."
  echo ""
fi

# ── Check for .env at all ─────────────────────────────────────
if [ ! -f ".env" ]; then
  echo "⚠  No .env file found. BlackVault may not be configured."
  echo "   If this is a fresh clone, run ./install.sh first."
  echo "   Continuing with Docker defaults (DATA_DIR=./data)..."
  echo ""
fi

# ── Database provider ─────────────────────────────────────────
# There is one compose file, and plain `$COMPOSE` reads .env: COMPOSE_PROFILES=
# postgres there runs PostgreSQL, no profile runs SQLite. The provider below
# only drives the preflight checks.
# docker compose must get the BLACKVAULT_* keys from .env only, never from
# this shell's environment (a shell variable would override .env).
unset BLACKVAULT_DATABASE_URL BLACKVAULT_DB_PROVIDER BLACKVAULT_POSTGRES_PASSWORD
DB_PROVIDER=$(provider_from_env)
echo "Database provider: $DB_PROVIDER"

# ── Read DATA_DIR from .env ────────────────────────────────────
# Only surrounding whitespace and quotes are stripped: paths may contain spaces.
ACTIVE_DATA_DIR=$(env_value DATA_DIR)

# ── Preflight: verify the database exists ─────────────────────
if [ "$DB_PROVIDER" != "sqlite" ]; then
  check_postgres_env || true
fi
if [ -n "$ACTIVE_DATA_DIR" ] && [ "$DB_PROVIDER" != "sqlite" ]; then
  # PostgreSQL keeps its cluster in $DATA_DIR/postgres. DATA_DIR is never
  # relocated here: moving it would bring up a new, empty database.
  if [ -d "$ACTIVE_DATA_DIR/postgres" ]; then
    echo "PostgreSQL data verified at: $ACTIVE_DATA_DIR/postgres"
  else
    echo "⚠  WARNING: No PostgreSQL data found at: $ACTIVE_DATA_DIR/postgres"
    echo "   DATA_DIR in .env is left unchanged. If your data lives elsewhere,"
    echo "   fix DATA_DIR in .env and re-run ./update.sh."
  fi
elif [ -n "$ACTIVE_DATA_DIR" ]; then
  DB_PATH="$ACTIVE_DATA_DIR/db/vault.db"
  if [ ! -f "$DB_PATH" ]; then
    echo "⚠  WARNING: No database found at expected location:"
    echo "   $DB_PATH"
    echo ""
    # Check legacy locations (SQLite installs only)
    LEGACY_DB=""
    if [ -f "./data/db/vault.db" ]; then
      LEGACY_DB="$(pwd)/data/db/vault.db"
    elif [ -f "$HOME/.blackvault/db/vault.db" ]; then
      LEGACY_DB="$HOME/.blackvault/db/vault.db"
    fi
    if [ -n "$LEGACY_DB" ]; then
      LEGACY_DATA_DIR=$(dirname "$(dirname "$LEGACY_DB")")
      echo "   Data found at: $LEGACY_DB"
      echo "   Auto-updating DATA_DIR in .env:"
      echo "     $ACTIVE_DATA_DIR  →  $LEGACY_DATA_DIR"
      sed -i.bak "s|^DATA_DIR=.*|DATA_DIR=$LEGACY_DATA_DIR|" .env
      ACTIVE_DATA_DIR="$LEGACY_DATA_DIR"
      echo "   .env updated. Continuing update..."
      echo ""
    else
      echo "   No existing database found in any known location."
      echo "   This may be a fresh install — continuing."
    fi
  else
    echo "Database verified at: $DB_PATH"
  fi
fi

echo ""

# ── Pull latest code ──────────────────────────────────────────
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Pulling latest updates from GitHub..."
  git pull
  echo ""
fi

# ── Rebuild and restart ───────────────────────────────────────
echo "Rebuilding BlackVault image..."
$COMPOSE build --pull

echo ""
echo "Restarting..."
$COMPOSE up -d

echo ""
echo "Waiting for health check..."
# The app healthcheck runs every 30s, so the first probe is not instant. Poll
# for up to two minutes: right after `up -d` the status reads
# "Up 2 seconds (health: starting)", which is neither healthy nor a failure.
STATUS="started (check logs if app doesn't load)"
for _ in $(seq 1 60); do
  if $COMPOSE ps --format '{{.Status}}' blackvault 2>/dev/null | grep -q "healthy"; then
    STATUS="running"
    break
  fi
  sleep 2
done

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Update complete.                   ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Status:   $STATUS"
if [ -n "$ACTIVE_DATA_DIR" ]; then
  echo "  Data:     $ACTIVE_DATA_DIR"
fi
ENV_PORT=$(env_value PORT)
echo "  URL:      http://localhost:${ENV_PORT:-3000}"
echo ""
echo "  To check logs: $COMPOSE logs -f"
echo ""
