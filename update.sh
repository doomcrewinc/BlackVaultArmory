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
# shellcheck source=scripts/public-url-prompts.sh
. ./scripts/public-url-prompts.sh
# shellcheck source=scripts/setup-token.sh
. ./scripts/setup-token.sh
# shellcheck source=scripts/encryption-key.sh
. ./scripts/encryption-key.sh

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
# Fix round 1 (I4). Releases before this one stored install.bat and
# update.bat with CRLF in the index while .gitattributes says
# `text eol=crlf`, so Git reports both as modified on every checkout, and a
# pull that changes them aborts ("Your local changes ... would be
# overwritten"). When the ONLY difference is line endings, Git is made to
# re-check the two files byte for byte (a temporary `-text` in
# .git/info/attributes, then `git update-index --refresh`), which records them
# as unchanged: they ARE the committed bytes. `git checkout -- <file>` does
# not help (it rewrites the same bytes and Git still reports them modified),
# and no file is rewritten. Real local edits are left alone.
# update.bat mirrors this in :clear_eol_only_change.
clear_bat_eol_only_changes() {
  local attrs backup=""
  git diff --quiet -- install.bat update.bat 2>/dev/null && return 0
  if ! git diff --ignore-cr-at-eol --quiet -- install.bat update.bat 2>/dev/null; then
    echo "Note: install.bat or update.bat has local edits; they are left alone."
    return 0
  fi
  echo "Clearing a line-ending-only difference in install.bat / update.bat before pulling..."
  attrs=$(git rev-parse --git-path info/attributes) || return 0
  mkdir -p "$(dirname "$attrs")" || return 0
  if [ -f "$attrs" ]; then
    backup="$attrs.blackvault-update.$$"
    cp -p "$attrs" "$backup" || return 0
  fi
  printf 'install.bat -text\nupdate.bat -text\n' >> "$attrs"
  # The files must be older than the index Git writes next, or Git treats
  # them as "racily clean" and compares them again with the normal attributes.
  sleep 1
  git update-index -q --refresh >/dev/null 2>&1 || true
  if [ -n "$backup" ]; then mv -f "$backup" "$attrs"; else rm -f "$attrs"; fi
}

# `git pull` replaces this file, but bash keeps running the copy it already
# opened: everything below would be the OLD script's steps. So when the pull
# brought anything new, start over with the new update.sh. The pull is
# skipped on that second run (BLACKVAULT_UPDATE_REEXEC=1); everything before
# this point is safe to run twice.
if git rev-parse --git-dir > /dev/null 2>&1; then
  if [ -n "${BLACKVAULT_UPDATE_REEXEC:-}" ]; then
    echo "Running the updated update.sh."
    echo ""
  else
    clear_bat_eol_only_changes
    echo "Pulling latest updates from GitHub..."
    HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || true)
    git pull
    echo ""
    if [ "$(git rev-parse HEAD 2>/dev/null || true)" != "$HEAD_BEFORE" ]; then
      echo "Restarting the update with the new update.sh..."
      echo ""
      BLACKVAULT_UPDATE_REEXEC=1 exec bash ./update.sh "$@"
    fi
  fi
fi
unset BLACKVAULT_UPDATE_REEXEC

# ── Public URL, trusted proxies, direct access ────────────────
# BLACKVAULT_PUBLIC_URL is required from this release on: the container will
# not start without it. With no .env there is no public URL, so rebuilding
# and restarting would take a running BlackVault down. Stop here instead,
# before anything is rebuilt. update.bat stops at the same point.
if [ ! -f ".env" ]; then
  echo "ERROR: No .env file, so no BLACKVAULT_PUBLIC_URL. BlackVault will not"
  echo "       start without it. Run ./install.sh, or create .env with a line"
  echo "       BLACKVAULT_PUBLIC_URL=https://vault.example.com and re-run ./update.sh."
  echo "       Nothing was rebuilt or restarted."
  exit 1
fi

CURRENT_URL=$(env_value BLACKVAULT_PUBLIC_URL)
NEW_URL=$(prompt_public_url "$CURRENT_URL")
[ "$NEW_URL" = "$CURRENT_URL" ] || set_env_value .env BLACKVAULT_PUBLIC_URL "$NEW_URL"

if ! grep -q '^BLACKVAULT_DIRECT_ACCESS_INITIAL=' .env; then
  echo ""
  echo "This release can refuse connections that bypass your reverse proxy."
  if [ "$(prompt_yes_no "Keep allowing direct access by IP (http://<ip>:<port>)?" y)" = "y" ]; then
    set_env_value .env BLACKVAULT_DIRECT_ACCESS_INITIAL on
  else
    set_env_value .env BLACKVAULT_DIRECT_ACCESS_INITIAL off
  fi
fi

if ! grep -q '^BLACKVAULT_TRUSTED_PROXIES=' .env; then
  set_env_value .env BLACKVAULT_TRUSTED_PROXIES "$(prompt_trusted_proxies)"
fi

# ── Field-encryption key ──────────────────────────────────────
# Created only if missing (scripts/encryption-key.sh); an existing key is
# never touched. The new image refuses to start without one.
echo ""
ensure_encryption_key || {
  echo "       Nothing was rebuilt or restarted."
  exit 1
}

# ── Rebuild ───────────────────────────────────────────────────
echo "Rebuilding BlackVault image..."
$COMPOSE build --pull

# ── Snapshot the database, BEFORE the new image starts ────────
# The first start of a new version can change the stored data (this release
# encrypts serial numbers and NFA records). On SQLite the snapshot stops the
# app; if it fails, the old container is started again and the update stops.
echo ""
echo "Snapshotting the database..."
if ! ./scripts/db-snapshot.sh; then
  echo ""
  echo "ERROR: the database snapshot failed, so the update stopped here. See above."
  echo "       The new version was NOT started."
  $COMPOSE start blackvault >/dev/null 2>&1 || true
  exit 1
fi

# ── Restart ───────────────────────────────────────────────────
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
echo "  URL:      $(env_value BLACKVAULT_PUBLIC_URL)"
echo ""
echo "  To check logs: $COMPOSE logs -f"
echo ""

# ── First-time setup token ────────────────────────────────────
# Printed only while no admin account exists (see scripts/setup-token.sh).
# The health wait above means the app has started and logged it by now.
show_setup_token "$(env_value BLACKVAULT_PUBLIC_URL)"
