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

# ── Helpers ──────────────────────────────────────────────────
# env_value / provider_from_env / check_postgres_env / require_compose live in
# one shared file. There is one compose file: plain `$COMPOSE` everywhere,
# .env picks the database.
# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh
# shellcheck source=scripts/public-url-prompts.sh
. ./scripts/public-url-prompts.sh
# shellcheck source=scripts/setup-token.sh
. ./scripts/setup-token.sh
# shellcheck source=scripts/encryption-key.sh
. ./scripts/encryption-key.sh

# Docker Compose v2.20+ (docker-compose.yml needs it). Exits before anything
# is written when it is missing or older.
require_compose
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
  # A line this script cannot read is not "no data here": going on to the
  # wizard would write a new .env over it.
  env_require_readable DATA_DIR "Nothing was changed." || exit 1
  env_require_readable BLACKVAULT_DB_PROVIDER "Nothing was changed." || exit 1
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
    # This image refuses to start without the field-encryption key; an
    # existing key is never touched.
    ensure_encryption_key || exit 1
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
  env_require_readable DATA_DIR "Correct the line in .env and re-run this script." || exit 1
  EXISTING_DATA_DIR=$(env_value DATA_DIR)
  if [ -n "$EXISTING_DATA_DIR" ] && [ -f "$EXISTING_DATA_DIR/db/vault.db" ]; then
    # Legacy configs predate PostgreSQL support: they are always SQLite, and a
    # .env with no COMPOSE_PROFILES line runs SQLite on the one compose file.
    echo "Found your existing database at: $EXISTING_DATA_DIR"
    ensure_encryption_key || exit 1
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
    if ! data_dir_round_trips "$DATA_DIR"; then
      {
        echo "ERROR: the path of that folder cannot be written to .env so that Docker Compose"
        echo "       reads it back unchanged (it holds a \$, or \" #\"). Move the BlackVault"
        echo "       folder to a path without those, and run this script again."
        echo "       Nothing was changed."
      } >&2
      exit 1
    fi
  fi
fi

# ── Data directory (if not already chosen) ───────────────────
if [ -z "$DATA_DIR" ]; then
  DEFAULT_DATA="$(pwd)/data"
  echo "Where should BlackVault store its data?"
  echo "  This folder will contain your database and uploaded images."
  echo "  Default: $DEFAULT_DATA"
  # What is written to .env must be a line the .env reader reads back as this
  # folder (see data_dir_round_trips). `read` does not expand anything, and
  # Docker Compose would later put the home folder in place of a leading ~ and
  # substitute a $VAR: a leading ~/ or $HOME/ is spelled out here, and any
  # other answer that would not be read back as typed is asked for again.
  while true; do
    if ! read -rp "  Data directory [press Enter for default]: " DATA_DIR_INPUT; then
      echo ""
      echo "ERROR: no data directory was given. Nothing was changed." >&2
      exit 1
    fi
    DATA_DIR="${DATA_DIR_INPUT:-$DEFAULT_DATA}"
    DATA_DIR="${DATA_DIR%/}"   # strip trailing slash
    # The patterns are the literal text ~ and $HOME, as typed.
    case "$DATA_DIR" in
      "~" | '$HOME') DATA_DIR="$HOME" ;;
      "~/"*) DATA_DIR="$HOME/${DATA_DIR#"~/"}" ;;
      '$HOME/'*) DATA_DIR="$HOME/${DATA_DIR#'$HOME/'}" ;;
      *) ;;
    esac
    if data_dir_round_trips "$DATA_DIR"; then
      break
    fi
    echo "  That folder cannot be used as typed: Docker Compose would read"
    echo "  DATA_DIR=$DATA_DIR as another folder. Type the full path, with no \$"
    echo "  in it and not starting with ~ (only a leading ~/ or \$HOME/ is spelled out"
    echo "  for you)."
    DATA_DIR=""
  done
fi

# ── Port ─────────────────────────────────────────────────────
echo ""
read -rp "Port to run BlackVault on [3000]: " PORT_INPUT
PORT="${PORT_INPUT:-3000}"

# ── Public URL, trusted proxies, direct access ────────────────
PUBLIC_URL=$(prompt_public_url)
TRUSTED_PROXIES=$(prompt_trusted_proxies)
DIRECT_ACCESS_INITIAL=""
if [ -z "$TRUSTED_PROXIES" ]; then
  echo ""
  echo "No trusted proxy set. With direct access off, every connection to"
  echo "BlackVault would be reset until you configure one."
  if [ "$(prompt_yes_no "Allow direct access until your proxy is set up?" y)" = "y" ]; then
    DIRECT_ACCESS_INITIAL="on"
  fi
fi

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
BLACKVAULT_PUBLIC_URL=$PUBLIC_URL
BLACKVAULT_TRUSTED_PROXIES=$TRUSTED_PROXIES
BLACKVAULT_DIRECT_ACCESS_INITIAL=$DIRECT_ACCESS_INITIAL
EOF
  else
    cat > .env <<EOF
# BlackVault configuration — generated by install.sh
DATA_DIR=$DATA_DIR
PORT=$PORT
BLACKVAULT_DB_PROVIDER=sqlite
BLACKVAULT_PUBLIC_URL=$PUBLIC_URL
BLACKVAULT_TRUSTED_PROXIES=$TRUSTED_PROXIES
BLACKVAULT_DIRECT_ACCESS_INITIAL=$DIRECT_ACCESS_INITIAL
EOF
  fi
)

echo "Configuration written to .env"
if [ "$DB_PROVIDER" = "postgres" ]; then
  echo "A random PostgreSQL password was generated and saved in .env (not shown)."
  echo "Keep .env safe: your database cannot be opened without it."
fi

# ── Field-encryption key ──────────────────────────────────────
# secrets/blackvault_encryption_key, mode 600; never overwritten if it is
# already there (scripts/encryption-key.sh).
echo ""
ensure_encryption_key || exit 1

# ── Build and start ───────────────────────────────────────────
echo ""
echo "Building BlackVault image (this may take a few minutes)..."
$COMPOSE build

echo ""
echo "Starting BlackVault..."
$COMPOSE up -d

echo ""
echo "Waiting for health check..."
# Polled as in update.sh. The app logs the first-time setup token while it
# starts, and a first start (migrations, and on PostgreSQL the database) takes
# longer than a fixed few seconds: once healthy, the token is in the log.
# wait_for_health (scripts/compose-provider.sh) says what ends the wait; the
# last state seen decides what is reported.
wait_for_health

if [[ "$HEALTH" == "healthy" ]]; then
  echo "BlackVault is running."
else
  echo "WARNING: $(health_problem_text). Check the logs with:"
  echo "  $COMPOSE logs blackvault"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
if [[ "$HEALTH" == "healthy" ]]; then
  echo "║  BlackVault is ready!                                    ║"
else
  echo "║  BlackVault was started, but is NOT healthy.             ║"
fi
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  URL:         $PUBLIC_URL"
echo "  Data stored: $DATA_DIR"
echo "  Database:    $DB_PROVIDER"
if [ "$DIRECT_ACCESS_INITIAL" = "on" ]; then
  echo "  Direct:      http://<this machine's IP>:$PORT (direct access on)"
fi
echo ""
echo "  To stop BlackVault:    $COMPOSE down"
echo "  To update BlackVault:  ./update.sh"
echo ""

# ── First-time setup token ────────────────────────────────────
# Printed only while no admin account exists (see scripts/setup-token.sh).
show_setup_token "$PUBLIC_URL"

# A container that is unhealthy, keeps restarting, has exited or is not there
# is a failed install for whoever started this script (another script, a
# provisioning tool). One that is still starting when the wait ran out is not:
# a slow first start can still come up.
if start_failed; then
  exit 1
fi
