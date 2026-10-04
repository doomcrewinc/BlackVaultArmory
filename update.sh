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
# shellcheck source=scripts/backup-common.sh
. ./scripts/backup-common.sh
# shellcheck source=scripts/public-url-prompts.sh
. ./scripts/public-url-prompts.sh
# shellcheck source=scripts/setup-token.sh
. ./scripts/setup-token.sh
# shellcheck source=scripts/encryption-key.sh
. ./scripts/encryption-key.sh

# ── install.bat / update.bat line endings ──
# Releases before this one stored install.bat and update.bat with CRLF in
# the index while .gitattributes says `text eol=crlf`, so Git reports both as
# modified on every checkout, and a pull that changes them aborts ("Your
# local changes ... would be overwritten"). When the ONLY difference is line
# endings, Git is made to re-check the two files byte for byte (a temporary
# `-text` in .git/info/attributes, then `git update-index --refresh`), which
# records them as unchanged: they ARE the committed bytes. `git checkout --
# <file>` does not help (it rewrites the same bytes and Git still reports them
# modified), and no file is rewritten. Real local edits are left alone.
# update.bat mirrors this in :clear_eol_only_change.
#
# The override must never outlive this script: left behind, every later
# checkout would write the .bat files with LF on Windows. So each added line
# carries the marker attribute `blackvault-update` (a `# comment` cannot be
# used: Git rejects a line with a trailing `#` token and ignores the whole
# line), EXIT/INT/TERM restore the file, and every run first strips marked
# lines left by a run that could not restore (SIGKILL, power loss).
BV_EOL_MARK="blackvault-update"
BV_EOL_ATTRS=""
BV_EOL_BACKUP=""
BV_EOL_ACTIVE=""

# Self-heal: removes override lines (and backups) left by an interrupted run.
heal_bat_eol_override() {
  local attrs tmp b
  git rev-parse --git-dir >/dev/null 2>&1 || return 0
  attrs=$(git rev-parse --git-path info/attributes 2>/dev/null) || return 0
  for b in "$attrs".blackvault-update.*; do
    if [ -e "$b" ]; then rm -f "$b"; fi
  done
  [ -f "$attrs" ] || return 0
  grep -q " $BV_EOL_MARK\$" "$attrs" || return 0
  echo "Removing a line-ending override left in .git/info/attributes by an interrupted update..."
  tmp="$attrs.blackvault-heal.$$"
  grep -v " $BV_EOL_MARK\$" "$attrs" > "$tmp" || true
  if [ -s "$tmp" ]; then mv -f "$tmp" "$attrs"; else rm -f "$tmp" "$attrs"; fi
}

# Puts .git/info/attributes back exactly as it was. Safe to call twice.
restore_bat_eol_override() {
  [ -n "$BV_EOL_ACTIVE" ] || return 0
  BV_EOL_ACTIVE=""
  if [ -n "$BV_EOL_BACKUP" ]; then mv -f "$BV_EOL_BACKUP" "$BV_EOL_ATTRS"; else rm -f "$BV_EOL_ATTRS"; fi
  # Whatever happened, no marked line may survive.
  heal_bat_eol_override >/dev/null 2>&1 || true
}

clear_bat_eol_only_changes() {
  git diff --quiet -- install.bat update.bat 2>/dev/null && return 0
  if ! git diff --ignore-cr-at-eol --quiet -- install.bat update.bat 2>/dev/null; then
    echo "Note: install.bat or update.bat has local edits; they are left alone."
    return 0
  fi
  echo "Clearing a line-ending-only difference in install.bat / update.bat before pulling..."
  BV_EOL_ATTRS=$(git rev-parse --git-path info/attributes) || return 0
  mkdir -p "$(dirname "$BV_EOL_ATTRS")" || return 0
  BV_EOL_BACKUP=""
  if [ -f "$BV_EOL_ATTRS" ]; then
    BV_EOL_BACKUP="$BV_EOL_ATTRS.blackvault-update.$$"
    cp -p "$BV_EOL_ATTRS" "$BV_EOL_BACKUP" || return 0
  fi
  BV_EOL_ACTIVE=1
  trap 'restore_bat_eol_override' EXIT
  trap 'restore_bat_eol_override; exit 130' INT
  trap 'restore_bat_eol_override; exit 143' TERM
  # An existing file without a final newline: start our lines on a new one.
  if [ -s "$BV_EOL_ATTRS" ] && [ -n "$(tail -c 1 "$BV_EOL_ATTRS")" ]; then
    printf '\n' >> "$BV_EOL_ATTRS"
  fi
  printf 'install.bat -text %s\nupdate.bat -text %s\n' "$BV_EOL_MARK" "$BV_EOL_MARK" >> "$BV_EOL_ATTRS"
  # The files must be older than the index Git writes next, or Git treats
  # them as "racily clean" and compares them again with the normal attributes.
  sleep 1
  git update-index -q --refresh >/dev/null 2>&1 || true
  restore_bat_eol_override
  trap - EXIT INT TERM
}

# Every run, before anything else.
heal_bat_eol_override


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
# BLACKVAULT_UPLOADS_SNAPSHOT is set below only for the one `up` after the
# uploads snapshot; an inherited value must never reach it.
unset BLACKVAULT_DATABASE_URL BLACKVAULT_DB_PROVIDER BLACKVAULT_POSTGRES_PASSWORD BLACKVAULT_UPLOADS_SNAPSHOT
# "Nothing was rebuilt or restarted", not "pulled": this point is reached a
# second time after the pull, when the new update.sh is started.
env_require_readable BLACKVAULT_DB_PROVIDER "Nothing was rebuilt or restarted." || exit 1
DB_PROVIDER=$(provider_from_env)
echo "Database provider: $DB_PROVIDER"

# ── Read DATA_DIR from .env ────────────────────────────────────
# Only surrounding whitespace and quotes are stripped: paths may contain spaces.
# An unreadable DATA_DIR (see scripts/compose-provider.sh) stops here, before
# the pull: the folder Compose will use is not known, so nothing below can be
# checked or snapshotted, and no other folder is put in its place.
env_require_readable DATA_DIR "Nothing was rebuilt or restarted." || exit 1
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
      # A DATA_DIR line in another form (export, spaces around =) is not
      # rewritten by the sed above: add a plain line after it, which wins.
      if [[ "$(env_value DATA_DIR)" != "$LEGACY_DATA_DIR" ]]; then
        set_env_value .env DATA_DIR "$LEGACY_DATA_DIR"
      fi
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

# ── A marker left by a restore ────────────────────────────────
# The new image refuses to start while a restore marker is in the uploads
# folder. Found here, before anything is asked, rebuilt or stopped, the
# version that is running keeps running.
if ! bv_restore_marker_refusal "${ACTIVE_DATA_DIR:-./data}/uploads"; then
  echo "       Then run ./update.sh again. Nothing was rebuilt or restarted."
  exit 1
fi

if env_unreadable BLACKVAULT_PUBLIC_URL; then
  echo "BLACKVAULT_PUBLIC_URL in .env could not be read (a \$ in it is not substituted here)."
  echo "Enter it again; it is added to .env as a plain line, which is the one Docker uses."
fi
CURRENT_URL=$(env_value BLACKVAULT_PUBLIC_URL)
NEW_URL=$(prompt_public_url "$CURRENT_URL")
[ "$NEW_URL" = "$CURRENT_URL" ] || set_env_value .env BLACKVAULT_PUBLIC_URL "$NEW_URL"

if ! env_has_key BLACKVAULT_DIRECT_ACCESS_INITIAL; then
  echo ""
  echo "This release can refuse connections that bypass your reverse proxy."
  if [ "$(prompt_yes_no "Keep allowing direct access by IP (http://<ip>:<port>)?" y)" = "y" ]; then
    set_env_value .env BLACKVAULT_DIRECT_ACCESS_INITIAL on
  else
    set_env_value .env BLACKVAULT_DIRECT_ACCESS_INITIAL off
  fi
fi

if ! env_has_key BLACKVAULT_TRUSTED_PROXIES; then
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
  rm -f backups/.uploads-snapshot-marker
  $COMPOSE start blackvault >/dev/null 2>&1 || true
  exit 1
fi

# scripts/db-snapshot.sh also snapshotted the uploads folder (unless
# it was empty or missing) and left its path in
# backups/.uploads-snapshot-marker. Read it once, then remove it — never
# write it to .env — and pass it to the ONE `up` below, so the app's own
# startup step does not take a second snapshot of the same files.
UPLOADS_SNAPSHOT_MARKER=""
if [ -s backups/.uploads-snapshot-marker ]; then
  UPLOADS_SNAPSHOT_MARKER=$(cat backups/.uploads-snapshot-marker)
fi
rm -f backups/.uploads-snapshot-marker

# ── Restart ───────────────────────────────────────────────────
echo ""
echo "Restarting..."
if [ -n "$UPLOADS_SNAPSHOT_MARKER" ]; then
  BLACKVAULT_UPLOADS_SNAPSHOT="$UPLOADS_SNAPSHOT_MARKER" $COMPOSE up -d
else
  $COMPOSE up -d
fi

echo ""
echo "Waiting for health check..."
# The app healthcheck runs every 30s, so the first probe is not instant. Poll
# for up to two minutes: right after `up -d` the status reads
# "Up 2 seconds (health: starting)", which is neither healthy nor a failure.
# Only the status word "healthy" ends the wait; the last status seen decides
# what is reported.
HEALTH=""
for _ in $(seq 1 60); do
  HEALTH=$(container_health)
  if [[ "$HEALTH" == "healthy" ]]; then
    break
  fi
  sleep 2
done
if [[ "$HEALTH" == "healthy" ]]; then
  STATUS="running"
elif [[ "$HEALTH" == "unhealthy" ]]; then
  STATUS="UNHEALTHY - the container's health check is failing, check the logs"
else
  STATUS="did not become healthy within two minutes, check the logs"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
if [[ "$HEALTH" == "healthy" ]]; then
  echo "║   Update complete.                   ║"
else
  echo "║   Update applied - app NOT healthy.  ║"
fi
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

# A container that reports unhealthy is a failed update for whoever started
# this script (cron, another script). One that is still starting when the
# wait ran out is not: a slow first start can still come up.
if [[ "$HEALTH" == "unhealthy" ]]; then
  exit 1
fi
