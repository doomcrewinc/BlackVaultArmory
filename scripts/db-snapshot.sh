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
#
# Task 4 (encrypted files at rest, spec 3b "Update scripts"): independent of
# PROVIDER, this script also copies $DATA_DIR/uploads into
# backups/uploads-<YYYYmmdd-HHMMSS>/ (directories mode 700, files mode 600,
# owned by the app user uid 1001), inside a one-off container of the app
# image (scripts/uploads-snapshot.sh; see the comment at UPLOADS_MARKER_FILE
# below). Skipped — still exit 0, no marker — when uploads/ is missing or has
# no files. On success it leaves the snapshot's path in
# backups/.uploads-snapshot-marker; the caller (update.sh / rotate-key.sh)
# reads that file once and removes it. update.sh passes it as
# BLACKVAULT_UPLOADS_SNAPSHOT to the ONE `up` that follows — never to .env —
# so the app's own startup step (src/lib/files/startup.ts) skips its own
# snapshot for that start only. A symbolic link anywhere under uploads/ is
# never followed and never copied.

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
DATA_DIR=$(env_value DATA_DIR)
DATA_DIR="${DATA_DIR:-./data}"

mkdir -p backups || fail "could not create the backups folder."
chmod 700 backups || fail "could not restrict the backups folder."

if [ "$PROVIDER" = "sqlite" ]; then
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
  # Created empty and chmod 600 BEFORE any data is copied in (a default ACL
  # on the folder overrides the umask); cp onto an existing file keeps its mode.
  (umask 077 && : > "$OUT.partial" && chmod 600 "$OUT.partial" && cp "$DB" "$OUT.partial") ||
    { rm -f "$OUT.partial"; fail "could not copy $DB (permissions? free disk space?)."; }
  for ext in -journal -wal; do
    if [ -f "$DB$ext" ]; then
      (umask 077 && : > "$OUT$ext" && chmod 600 "$OUT$ext" && cp "$DB$ext" "$OUT$ext") ||
        { rm -f "$OUT.partial" "$OUT$ext"; fail "could not copy $DB$ext."; }
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

# ── Uploads snapshot (Task 4) ───────────────────────────────────
# A copy of $DATA_DIR/uploads into backups/uploads-<TS>/, written under a
# .partial name and renamed only once complete — same reason as $OUT above.
# Every directory is mode 700; every file is created empty and chmod 600
# BEFORE its contents are written (the 3a lesson: a default ACL on the
# parent can override the umask).
#
# Symlinks: never followed, never copied — `find` without -L already does
# not descend into a symlinked directory, and a symlinked file is reported
# and skipped below. A link copied into backups/ could resolve to something
# outside uploads/ once that folder is moved, zipped or restored elsewhere,
# and BlackVault itself never treats an uploaded file as a link
# (src/lib/files/startup.ts skips them the same way).
#
# The marker is a plain file, backups/.uploads-snapshot-marker — never a
# BLACKVAULT_* name and never written to .env: update.sh reads it once,
# right after this script returns, and exports it as
# BLACKVAULT_UPLOADS_SNAPSHOT for that one `up` only, so a stale marker from
# an earlier run can never suppress a snapshot the app genuinely needs on
# some later, unrelated start. Cleared at the start of every run, so a
# failure below (or a caller, like rotate-key.sh, that never reads it)
# cannot leave a stale one behind either.
UPLOADS_MARKER_FILE="backups/.uploads-snapshot-marker"
rm -f "$UPLOADS_MARKER_FILE"

# The copy runs INSIDE a one-off container of the app image (spec 3b, fix for
# Task 6): the uploaded files are BVF1 files mode 600 owned by the app user
# (uid 1001), and the app's .pre-encryption-* folders are mode 700, so on
# Linux the host user cannot read them. scripts/uploads-snapshot.sh starts as
# root in the container only to create backups/uploads-<TS>.partial for uid
# 1001 and rename it; the copy itself runs as 1001 (su-exec). The script is
# mounted from this checkout, not taken from the image, so an older image
# still runs the current copy rules. Only root reads the mounted file (it
# passes the text on to the 1001 stage), so a checkout made under umask 027
# or 077, where the file is 0640/0600 and owned by the host user, still works. The snapshot belongs to uid 1001: on
# Linux the host user needs sudo to delete it (elsewhere Docker Desktop and
# OrbStack show it as the host user's own). It skips .pre-encryption-* folders and *.tmp / *.rot files,
# and never follows a symbolic link. Exit 3 from it means "nothing to copy".
UPLOADS_SRC="$DATA_DIR/uploads"
if [ ! -d "$UPLOADS_SRC" ]; then
  echo "No uploads folder at $UPLOADS_SRC yet; skipping the uploads snapshot."
  exit 0
fi
# Never build or pull here: update.sh has just built the image, and
# rotate-key.sh runs with the existing app's image. A missing image is an error.
APP_IMAGE=$($COMPOSE config --images blackvault 2>/dev/null | head -n 1) || true
[ -n "$APP_IMAGE" ] || fail "could not work out the BlackVault image name from docker-compose.yml."
docker image inspect "$APP_IMAGE" >/dev/null 2>&1 ||
  fail "the BlackVault image $APP_IMAGE does not exist yet, so the uploads folder could not be snapshotted. Build it first ($COMPOSE build)."
UPLOADS_NAME="uploads-$TS"
[ -e "backups/$UPLOADS_NAME" ] && UPLOADS_NAME="uploads-$TS-$$"
rc=0
$COMPOSE run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh \
  -v "$PWD/backups:/bv-backups" \
  -v "$PWD/scripts/uploads-snapshot.sh:/bv-uploads-snapshot.sh:ro" \
  blackvault /bv-uploads-snapshot.sh /app/uploads /bv-backups "$UPLOADS_NAME" || rc=$?
case "$rc" in
  0)
    UPLOADS_OUT="backups/$UPLOADS_NAME"
    (umask 077 && : > "$UPLOADS_MARKER_FILE" && chmod 600 "$UPLOADS_MARKER_FILE" && printf '%s' "$UPLOADS_OUT" > "$UPLOADS_MARKER_FILE") ||
      echo "WARNING: could not write $UPLOADS_MARKER_FILE; the app may take its own snapshot of the uploads folder on its next start."
    echo ""
    if [[ "$(uname -s 2>/dev/null)" == "Linux" ]]; then
      DELETE_ADVICE="delete it with sudo"
    else
      DELETE_ADVICE="delete it once BlackVault is confirmed working"
    fi
    echo "Uploads snapshot saved: $UPLOADS_OUT (owned by the app user, uid 1001; $DELETE_ADVICE)"
    ;;
  3)
    echo "No files in $UPLOADS_SRC to snapshot; skipping the uploads snapshot."
    ;;
  *)
    fail "could not snapshot the uploads folder $UPLOADS_SRC (exit $rc; see the ERROR above). No partial copy was kept."
    ;;
esac
