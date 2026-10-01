#!/bin/bash
set -Eeo pipefail

# db-snapshot.sh — copy BlackVault's database into backups/ next to
# docker-compose.yml, before an upgrade or a key rotation.
# (field-encryption spec §3 "Update scripts" and "Rotation",
#  docs/superpowers/specs/2026-09-30-field-encryption-design.md)
#
# Called by update.sh (before the new image starts) and rotate-key.sh (after
# it has stopped the app). scripts\db-snapshot.bat is the Windows twin:
# change them together.
#
# Contract (ruling R4): no arguments; exit 0 only when a snapshot was written
# (or there is no database yet to copy); any failure exits non-zero, and the
# caller stops. Prints the path of the snapshot it wrote.
#
#   SQLite      stops the app (a consistent copy), then copies
#               $DATA_DIR/db/vault.db to backups/blackvault-<YYYYmmdd-HHMMSS>.db.
#               It does NOT start the app again: the caller decides.
#   PostgreSQL  pg_dump through the db container (started if needed) to
#               backups/blackvault-<YYYYmmdd-HHMMSS>.sql. The app keeps running.
#
# backups/ is mode 700 and every snapshot mode 600: it is a plain copy of the
# database.

# Run from the folder that holds docker-compose.yml (this script's parent).
cd "$(dirname "$0")/.."

# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh

require_compose
# docker compose must get the BLACKVAULT_* keys from .env only, never from
# this shell's environment (a shell variable would override .env).
unset BLACKVAULT_DATABASE_URL BLACKVAULT_DB_PROVIDER BLACKVAULT_POSTGRES_PASSWORD

fail() {
  echo "ERROR: database snapshot failed: $*"
  exit 1
}

PROVIDER=$(provider_from_env)
TS="$(date -u +%Y%m%d-%H%M%S)"

mkdir -p backups || fail "could not create the backups folder."
chmod 700 backups || fail "could not restrict the backups folder."

if [ "$PROVIDER" = "sqlite" ]; then
  DATA_DIR=$(env_value DATA_DIR)
  DATA_DIR="${DATA_DIR:-./data}"
  DB="$DATA_DIR/db/vault.db"
  if [ ! -f "$DB" ]; then
    echo "No SQLite database at $DB yet; nothing to snapshot."
    exit 0
  fi
  OUT="backups/blackvault-$TS.db"
  [ -e "$OUT" ] && OUT="backups/blackvault-$TS-$$.db"
  echo "Stopping BlackVault for a consistent copy of the database..."
  $COMPOSE stop blackvault || fail "could not stop BlackVault."
  # A copy taken with the app stopped. A leftover rollback journal or WAL
  # (after a crash) belongs to the database, so it is copied beside it.
  # chmod as well as umask: a default ACL on the folder overrides the umask.
  (umask 077 && cp "$DB" "$OUT.partial" && chmod 600 "$OUT.partial") ||
    { rm -f "$OUT.partial"; fail "could not copy $DB (permissions? free disk space?)."; }
  for ext in -journal -wal; do
    if [ -f "$DB$ext" ]; then
      (umask 077 && cp "$DB$ext" "$OUT$ext" && chmod 600 "$OUT$ext") || { rm -f "$OUT.partial"; fail "could not copy $DB$ext."; }
    fi
  done
  mv "$OUT.partial" "$OUT" || fail "could not finish writing $OUT."
else
  OUT="backups/blackvault-$TS.sql"
  [ -e "$OUT" ] && OUT="backups/blackvault-$TS-$$.sql"
  echo "Making sure the database container is running..."
  $COMPOSE up -d --wait db || fail "could not start the database container."
  echo "Dumping the PostgreSQL database..."
  if ! (umask 077 && : > "$OUT.partial" && chmod 600 "$OUT.partial" &&
    $COMPOSE exec -T db pg_dump -U blackvault -d blackvault > "$OUT.partial"); then
    rm -f "$OUT.partial"
    fail "pg_dump failed."
  fi
  if [ ! -s "$OUT.partial" ]; then
    rm -f "$OUT.partial"
    fail "pg_dump wrote nothing."
  fi
  mv "$OUT.partial" "$OUT" || fail "could not finish writing $OUT."
fi

chmod 600 "$OUT"
echo ""
echo "Database snapshot saved: $OUT"
echo "WARNING: this snapshot is a plain, unencrypted copy of the database file. Names,"
echo "         notes and everything else in it can be read by anyone who can read the"
echo "         file. Serial numbers and NFA records too, if it was taken before field"
echo "         encryption was first turned on; otherwise they need the encryption key"
echo "         that was in use when it was taken."
echo "         Delete it once BlackVault is confirmed working:  rm $OUT"
