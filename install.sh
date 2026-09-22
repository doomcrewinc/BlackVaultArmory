#!/bin/bash
set -e

# .env and docker-compose.yml live next to this script: always run from here.
cd "$(dirname "$0")"

echo "╔══════════════════════════════════════════╗"
echo "║      BlackVault — Setup Wizard           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Prerequisites check ─────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is not installed or not in your PATH."
  echo "       Install it from https://docs.docker.com/get-docker/ and re-run."
  exit 1
fi

if ! docker compose version &>/dev/null 2>&1 && ! docker-compose version &>/dev/null 2>&1; then
  echo "ERROR: 'docker compose' (v2) or 'docker-compose' is required."
  echo "       Upgrade Docker Desktop or install the Compose plugin."
  exit 1
fi

if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

# ── Helpers ──────────────────────────────────────────────────
# env_value / provider_from_env / check_postgres_env live in one shared file.
# There is one compose file: plain `$COMPOSE` everywhere, .env picks the database.
# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh
# docker compose must get the BLACKVAULT_* keys from .env only, never from
# this shell's environment (a shell variable would override .env).
unset BLACKVAULT_DATABASE_URL BLACKVAULT_DB_PROVIDER BLACKVAULT_POSTGRES_PASSWORD

# Random hex secret. Never echoed to the terminal.
generate_password() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ── Check for existing .env (already configured) ─────────────
if [ -f ".env" ]; then
  echo "Existing .env found — BlackVault is already configured."
  echo "To reconfigure, delete .env and re-run this script."
  echo ""
  EXISTING_DATA_DIR=$(env_value DATA_DIR)
  EXISTING_PROVIDER=$(provider_from_env)
  if [ -n "$EXISTING_DATA_DIR" ] && {
    { [ "$EXISTING_PROVIDER" = "sqlite" ] && [ -f "$EXISTING_DATA_DIR/db/vault.db" ]; } ||
    { [ "$EXISTING_PROVIDER" != "sqlite" ] && [ -d "$EXISTING_DATA_DIR/postgres" ]; }
  }; then
    echo "Your data is at: $EXISTING_DATA_DIR ($EXISTING_PROVIDER)"
    if [ "$EXISTING_PROVIDER" != "sqlite" ]; then
      check_postgres_env || true
    fi
    echo "Starting with existing configuration..."
    $COMPOSE up -d
    exit 0
  fi
fi

# ── Check for legacy .blackvault.env (migrate it) ────────────
if [ ! -f ".env" ] && [ -f ".blackvault.env" ]; then
  echo "Found legacy config file: .blackvault.env"
  echo "Migrating to .env (Docker reads .env automatically)..."
  cp .blackvault.env .env
  echo "Migrated. Original .blackvault.env kept as backup."
  echo ""
  EXISTING_DATA_DIR=$(env_value DATA_DIR)
  if [ -n "$EXISTING_DATA_DIR" ] && [ -f "$EXISTING_DATA_DIR/db/vault.db" ]; then
    # Legacy configs predate PostgreSQL support: they are always SQLite, and a
    # .env with no COMPOSE_PROFILES line runs SQLite on the one compose file.
    echo "Found your existing database at: $EXISTING_DATA_DIR"
    echo "Rebuilding with existing configuration (SQLite)..."
    $COMPOSE build
    $COMPOSE up -d
    echo ""
    echo "Update complete. Your data is unchanged."
    exit 0
  fi
fi

# ── Detect data in legacy locations ──────────────────────────
LEGACY_DATA=""
if [ -f "./data/db/vault.db" ]; then
  LEGACY_DATA="$(pwd)/data"
fi
if [ -z "$LEGACY_DATA" ] && [ -f "$HOME/.blackvault/db/vault.db" ]; then
  LEGACY_DATA="$HOME/.blackvault"
fi

if [ -n "$LEGACY_DATA" ]; then
  echo "⚠  Existing BlackVault data found at: $LEGACY_DATA"
  echo "   Would you like to keep using this location?"
  read -rp "   Keep existing data location? [Y/n]: " KEEP_INPUT
  KEEP="${KEEP_INPUT:-Y}"
  if [[ "$KEEP" =~ ^[Yy] ]]; then
    DATA_DIR="$LEGACY_DATA"
    echo "   Using existing data at: $DATA_DIR"
  fi
fi

# ── Data directory (if not already chosen) ───────────────────
if [ -z "$DATA_DIR" ]; then
  DEFAULT_DATA="$(pwd)/data"
  echo "Where should BlackVault store its data?"
  echo "  This folder will contain your database and uploaded images."
  echo "  Default: $DEFAULT_DATA"
  read -rp "  Data directory [press Enter for default]: " DATA_DIR_INPUT
  DATA_DIR="${DATA_DIR_INPUT:-$DEFAULT_DATA}"
  DATA_DIR="${DATA_DIR%/}"   # strip trailing slash
fi

# ── Port ─────────────────────────────────────────────────────
echo ""
read -rp "Port to run BlackVault on [3000]: " PORT_INPUT
PORT="${PORT_INPUT:-3000}"

# ── Database ─────────────────────────────────────────────────
# Existing SQLite data that the user chose to keep defaults to SQLite, so the
# installer never silently starts an empty PostgreSQL database beside it.
DB_DEFAULT="1"
if [ -f "$DATA_DIR/db/vault.db" ]; then
  DB_DEFAULT="2"
fi
echo ""
echo "Which database should BlackVault use?"
echo "  1) PostgreSQL — recommended (runs as a second container)"
echo "  2) SQLite     — single file, single container"
if [ "$DB_DEFAULT" = "2" ]; then
  echo "  Existing SQLite data found, so SQLite is the default."
  echo "  To move it to PostgreSQL later, see \"Moving from SQLite to PostgreSQL\" in README.md."
fi
while true; do
  read -rp "Database [$DB_DEFAULT]: " DB_INPUT
  case "$(echo "${DB_INPUT:-$DB_DEFAULT}" | tr '[:upper:]' '[:lower:]')" in
    1|p|postgres|postgresql) DB_PROVIDER="postgres"; break ;;
    2|s|sqlite) DB_PROVIDER="sqlite"; break ;;
    *) echo "  Please enter 1 (PostgreSQL) or 2 (SQLite)." ;;
  esac
done

POSTGRES_PASSWORD=""
if [ "$DB_PROVIDER" = "postgres" ]; then
  if [ -e "$DATA_DIR/postgres/PG_VERSION" ]; then
    echo ""
    echo "ERROR: PostgreSQL data already exists at $DATA_DIR/postgres,"
    echo "       but there is no .env holding its password. A new password"
    echo "       would not match it. Restore your previous .env, or move"
    echo "       that folder aside to start fresh, then re-run this script."
    exit 1
  fi
  POSTGRES_PASSWORD=$(generate_password)
  if [ -z "$POSTGRES_PASSWORD" ]; then
    echo "ERROR: could not generate a database password (need openssl or /dev/urandom)."
    exit 1
  fi
fi

# ── Create directories ────────────────────────────────────────
echo ""
echo "Creating data directories..."
if [ "$DB_PROVIDER" = "sqlite" ]; then
  mkdir -p "$DATA_DIR/db" "$DATA_DIR/uploads"
else
  mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/db" "$DATA_DIR/uploads"
fi

# ── Write .env ────────────────────────────────────────────────
# .env holds the database password: create it readable by this user only.
# PostgreSQL: COMPOSE_PROFILES=postgres turns on the db service in the single
# docker-compose.yml. The password is hex, so it goes into the URL as-is.
# SQLite: no profile and no database keys, so the compose defaults apply.
# The keys are BLACKVAULT_* so a DATABASE_URL exported in the user's shell can
# never override them (see docker-compose.yml).
(
  umask 077
  if [ "$DB_PROVIDER" = "postgres" ]; then
    cat > .env <<EOF
# BlackVault configuration — generated by install.sh
DATA_DIR=$DATA_DIR
PORT=$PORT
COMPOSE_PROFILES=postgres
BLACKVAULT_DB_PROVIDER=postgres
BLACKVAULT_POSTGRES_PASSWORD=$POSTGRES_PASSWORD
BLACKVAULT_DATABASE_URL=postgresql://blackvault:$POSTGRES_PASSWORD@db:5432/blackvault
EOF
  else
    cat > .env <<EOF
# BlackVault configuration — generated by install.sh
DATA_DIR=$DATA_DIR
PORT=$PORT
BLACKVAULT_DB_PROVIDER=sqlite
EOF
  fi
)

echo "Configuration written to .env"
if [ "$DB_PROVIDER" = "postgres" ]; then
  echo "A random PostgreSQL password was generated and saved in .env (not shown)."
  echo "Keep .env safe: your database cannot be opened without it."
fi

# ── Build and start ───────────────────────────────────────────
echo ""
echo "Building BlackVault image (this may take a few minutes)..."
$COMPOSE build

echo ""
echo "Starting BlackVault..."
$COMPOSE up -d

echo ""
echo "Waiting for health check..."
sleep 5

if $COMPOSE ps | grep -q "healthy\|running"; then
  echo "BlackVault is running."
else
  echo "Container started — check logs with:"
  echo "  $COMPOSE logs -f"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  BlackVault is ready!                                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  URL:         http://localhost:$PORT"
echo "  Data stored: $DATA_DIR"
echo "  Database:    $DB_PROVIDER"
echo ""
echo "  To stop BlackVault:    $COMPOSE down"
echo "  To update BlackVault:  ./update.sh"
echo ""
