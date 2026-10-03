#!/bin/bash
# restore.sh — rebuild this BlackVault install from a full backup.
# (full-backups spec §3, docs/superpowers/specs/2026-10-02-full-backups-design.md)
# restore.bat is the Windows twin: change them together.
#
#   ./restore.sh <file> [--passphrase-file <path>] [--yes]
#
# <file> is a full backup made by ./backup.sh or the Settings button
# (blackvault-full-<time>.bvb): a file name in the backup folder
# (BLACKVAULT_BACKUP_DIR in .env, by default <DATA_DIR>/backups), or a path to
# a file in that folder. Copy the backup there first.
#
# IT REPLACES EVERYTHING the backup holds: every record in the database and
# every uploaded photo and document. User accounts, settings and the audit
# log are not part of a backup and are kept. The backup may come from
# another machine, with a different encryption key: the files and the
# protected fields are re-encrypted with THIS install's key.
#
# WHAT IT DOES, in this order:
#   1. Checks the backup in a one-off container (a full decrypt, every file
#      against its checksum). A wrong passphrase or a damaged file stops
#      here: nothing was changed and BlackVault was not stopped.
#   2. Asks you to type RESTORE (skipped with --yes).
#   3. Stops BlackVault and takes a snapshot of the database and the uploads
#      folder into backups/ (scripts/db-snapshot.sh). If that fails it
#      starts BlackVault again and stops: nothing was changed.
#   4. Restores, in a one-off container: the backup's files are written
#      (encrypted with this install's key) into uploads/.restore-<time>/, the
#      database records are replaced in one transaction, then the current
#      images/ and documents/ folders are moved into
#      uploads/.pre-restore-<time>/ and the restored ones take their place.
#   5. Starts BlackVault.
# IF STEP 4 FAILS, for any reason, the database and the uploads are put back
# from the snapshot of step 3 automatically, BlackVault is started again, and
# this script exits 1: the install is as it was. If that rollback itself
# fails, BlackVault is NOT started, and the script prints where the snapshot
# is and the exact commands to put it back by hand.
#
# uploads/.pre-restore-<time>/ (what was there before) is never deleted by
# BlackVault. Delete it, and the snapshot in backups/, once you have checked
# the restored install.
#
# PASSPHRASE. The same rules as backup.sh: --passphrase-file is handed to
# the programs on their standard input, byte for byte; without it you are
# asked once, without echo. It is never put on a command line or into the
# environment of any program. With no --passphrase-file and no terminal this
# script stops at once.
#
# --yes. Without a terminal there is nobody to type RESTORE, so --yes is
# required; without it the script stops before anything is checked, stopped
# or changed.
#
# HOW IT RUNS. Steps 1 and 4 are
#   docker compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify <name>
#   docker compose run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp <time> <name>
# with no `--user` and no `--no-deps`, for the reasons given in backup.sh
# (the entrypoint places the encryption key as root, then drops to uid 1001;
# PostgreSQL must be running). The rollback's file work runs as root in a
# one-off container (scripts/snapshot-restore.sh): the snapshot and the live
# files belong to different users.
#
# OUTPUT. On success, one line on standard output, from the restore program:
#   BLACKVAULT_FULL_RESTORE_OK file=<name> files=<n> bytes=<n> pre_restore=<folder>
# Everything else goes to standard error. A failure ends with one ERROR line
# that says whether anything was changed.
#
# EXIT CODE. 0 restored · 1 failed (rolled back, or nothing was changed).
set -o pipefail
# No `set -e` on purpose (as in backup.sh): every failure is handled where it happens.

USAGE="Usage: ./restore.sh <file> [--passphrase-file <path>] [--yes]"

# ── 0. The install ────────────────────────────────────────────
# Paths given on the command line are relative to where the user ran this
# script from. scripts/backup-common.sh holds what is shared with backup.sh.
ORIG_PWD=$PWD
cd "$(dirname "$0")" || { printf 'ERROR: %s\n' "cannot change to the folder restore.sh is in. Nothing was changed." >&2; exit 1; }
for f in scripts/compose-provider.sh scripts/backup-common.sh scripts/db-snapshot.sh scripts/snapshot-restore.sh; do
  [ -f "./$f" ] || { printf 'ERROR: %s\n' "$f is missing; run restore.sh from a complete BlackVault folder. Nothing was changed." >&2; exit 1; }
done
# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh
# shellcheck source=scripts/backup-common.sh
. ./scripts/backup-common.sh

# ── 1. Arguments ──────────────────────────────────────────────
# An unknown argument is never echoed back: it could be a passphrase typed
# on the command line by mistake.
PASSFILE=""
YES=""
FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --passphrase-file)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || die "--passphrase-file needs a path. $USAGE"
      PASSFILE=$2
      shift 2
      ;;
    --yes)
      YES=1
      shift
      ;;
    -h | --help)
      printf '%s\n' "$USAGE"
      exit 0
      ;;
    -*)
      die "unknown argument. $USAGE"
      ;;
    *)
      [ -z "$FILE" ] || die "unknown argument. $USAGE"
      FILE=$1
      shift
      ;;
  esac
done
[ -n "$FILE" ] || die "no backup file was given. $USAGE"

bv_check_passphrase_source
# Ruling R21: a restore replaces all data. Nobody at a terminal to confirm → --yes, or stop now.
if [ -z "$YES" ] && [ ! -t 0 ]; then
  die "a restore replaces all data and must be confirmed, but standard input is not a terminal. Add --yes to confirm. Nothing was done."
fi

bv_compose_setup
bv_backup_file_name restore "$FILE"
NAME=$BACKUP_FILE_NAME
PROVIDER=$(provider_from_env)

# ── 2. The passphrase (asked once), then verify: nothing is changed yet ──
if [ -z "$PASSFILE" ]; then
  bv_echo_off
  ask_passphrase "Backup passphrase: "
  restore_tty
fi

echo "Checking the backup $NAME (nothing is changed yet)..." >&2
CMD=($COMPOSE run --rm -T blackvault node dist/scripts/full-backup.mjs --verify "$NAME")
bv_run_with_passphrase >&2
if [ "$RC" -ne 0 ]; then
  PASSPHRASE=""
  die "the backup $NAME did not pass the check (the reason is on the line above). Nothing was changed; BlackVault was not stopped."
fi

# ── 3. Confirm ────────────────────────────────────────────────
if [ -z "$YES" ]; then
  {
    echo ""
    echo "This will REPLACE what is in this BlackVault install with the backup $NAME:"
    echo "  - every record in the database (firearms, accessories, ammunition, gear,"
    echo "    documents, range sessions, kits, ...)"
    echo "  - every uploaded photo and document"
    echo "User accounts, settings and the audit log are kept. The photos and documents"
    echo "that are here now are kept in the uploads folder, under .pre-restore-<time>/."
    echo "BlackVault is stopped while this runs."
    printf 'Type RESTORE to continue: '
  } >&2
  IFS= read -r CONFIRM || CONFIRM=""
  if [ "$CONFIRM" != "RESTORE" ]; then
    PASSPHRASE=""
    die "not confirmed. Nothing was changed; BlackVault was not stopped."
  fi
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"

start_app() {
  $COMPOSE up -d >&2
}

# The rollback's file work: scripts/snapshot-restore.sh as root in a one-off
# container, backups/ mounted read-only. The script is mounted from this
# checkout, like scripts/uploads-snapshot.sh in db-snapshot.sh.
SNAPSHOT_RESTORE=($COMPOSE run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh
  -v "$PWD/backups:/bv-backups:ro"
  -v "$PWD/scripts/snapshot-restore.sh:/bv-snapshot-restore.sh:ro"
  blackvault /bv-snapshot-restore.sh)
PSQL=($COMPOSE exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault)

# PostgreSQL: the dump is loaded into a NEW database first, in one
# transaction. Only when that worked is the live database dropped and the
# new one given its name, so a dump that does not load leaves the live
# database alone.
rollback_postgres() {
  $COMPOSE up -d --wait db >&2 || return 1
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault" >&2 || return 1
  "${PSQL[@]}" -d blackvault_rollback --single-transaction -f - < "$DB_SNAPSHOT" > /dev/null || return 1
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault" >&2 || return 1
}

rollback_database() {
  if [ "$PROVIDER" = "sqlite" ]; then
    "${SNAPSHOT_RESTORE[@]}" sqlite "/bv-backups/$(basename "$DB_SNAPSHOT")" /app/data/vault.db >&2
  else
    rollback_postgres
  fi
}

rollback_uploads() {
  if [ -n "$UPLOADS_SNAPSHOT" ]; then
    "${SNAPSHOT_RESTORE[@]}" uploads /app/uploads "$STAMP" "/bv-backups/$(basename "$UPLOADS_SNAPSHOT")" >&2
  else
    "${SNAPSHOT_RESTORE[@]}" uploads /app/uploads "$STAMP" >&2
  fi
}

# Where the snapshot is and exactly what to run, for when this script cannot
# do it itself (the rollback failed, or the script was interrupted).
print_manual_recovery() {
  {
    echo "       The install as it was before the restore is in this snapshot:"
    echo "         database: $DB_SNAPSHOT"
    if [ -n "$UPLOADS_SNAPSHOT" ]; then
      echo "         uploads:  $UPLOADS_SNAPSHOT"
    else
      echo "         uploads:  (the uploads folder had no files; none were copied)"
    fi
    echo "       To put it back by hand, from $PWD:"
    echo "         $COMPOSE stop blackvault"
    if [ "$PROVIDER" = "sqlite" ]; then
      echo "         ${SNAPSHOT_RESTORE[*]} sqlite /bv-backups/$(basename "$DB_SNAPSHOT") /app/data/vault.db"
    else
      echo "         $COMPOSE up -d --wait db"
      echo "         ${PSQL[*]} -d postgres -c \"DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)\" -c \"CREATE DATABASE blackvault_rollback OWNER blackvault\""
      echo "         ${PSQL[*]} -d blackvault_rollback --single-transaction -f - < $DB_SNAPSHOT"
      echo "         ${PSQL[*]} -d postgres -c \"DROP DATABASE IF EXISTS blackvault WITH (FORCE)\" -c \"ALTER DATABASE blackvault_rollback RENAME TO blackvault\""
    fi
    if [ -n "$UPLOADS_SNAPSHOT" ]; then
      echo "         ${SNAPSHOT_RESTORE[*]} uploads /app/uploads $STAMP /bv-backups/$(basename "$UPLOADS_SNAPSHOT")"
    else
      echo "         ${SNAPSHOT_RESTORE[*]} uploads /app/uploads $STAMP"
    fi
    echo "         $COMPOSE up -d"
  } >&2
}

# ── 4. Stop the app, snapshot the database and the uploads ────
echo "Stopping BlackVault..." >&2
if ! $COMPOSE stop blackvault >&2; then
  PASSPHRASE=""
  die "could not stop BlackVault. Nothing was changed."
fi

echo "Taking a snapshot of the database and the uploads folder..." >&2
SNAPSHOT_OUTPUT=$(./scripts/db-snapshot.sh 2>&1)
SNAPSHOT_RC=$?
printf '%s\n' "$SNAPSHOT_OUTPUT" >&2
# "Database snapshot saved: <path>" is db-snapshot.sh's contract (ruling R4: it prints the path it wrote).
DB_SNAPSHOT=$(printf '%s\n' "$SNAPSHOT_OUTPUT" | sed -n 's/^Database snapshot saved: //p' | tail -n 1)
UPLOADS_SNAPSHOT=""
if [ -f backups/.uploads-snapshot-marker ]; then
  UPLOADS_SNAPSHOT=$(cat backups/.uploads-snapshot-marker 2>/dev/null) || UPLOADS_SNAPSHOT=""
fi
# The marker is for update.sh's next `up`; a restore leaves no plaintext for the app to snapshot.
rm -f backups/.uploads-snapshot-marker
if [ "$SNAPSHOT_RC" -ne 0 ]; then
  PASSPHRASE=""
  start_app || echo "WARNING: BlackVault did not start again; start it by hand: $COMPOSE up -d" >&2
  die "the snapshot before the restore failed (see above), so the restore did not start. Nothing was changed."
fi
if [ -z "$DB_SNAPSHOT" ] || [ ! -f "$DB_SNAPSHOT" ]; then
  PASSPHRASE=""
  start_app || echo "WARNING: BlackVault did not start; start it by hand: $COMPOSE up -d" >&2
  die "there is no database to snapshot yet, so a failed restore could not be undone. Start BlackVault once ($COMPOSE up -d), wait until it is up, then run the restore again. Nothing was changed."
fi

interrupted() {
  PASSPHRASE=""
  printf 'ERROR: %s\n' "the restore was interrupted. BlackVault is stopped and the install may be half restored." >&2
  print_manual_recovery
  exit 1
}
trap interrupted INT TERM HUP

# ── 5. Restore ────────────────────────────────────────────────
echo "Restoring $NAME. A large backup can take a while..." >&2
CMD=($COMPOSE run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp "$STAMP" "$NAME")
bv_run_with_passphrase
PASSPHRASE=""

if [ "$RC" -eq 0 ]; then
  trap - INT TERM HUP
  echo "Starting BlackVault..." >&2
  if ! start_app; then
    die "the restore is complete and was NOT rolled back, but BlackVault did not start. Check the logs ($COMPOSE logs blackvault) and start it by hand: $COMPOSE up -d"
  fi
  {
    echo "Restore complete."
    echo "  The photos and documents that were here before: <uploads folder>/.pre-restore-$STAMP/"
    echo "  The snapshot taken before the restore: $DB_SNAPSHOT${UPLOADS_SNAPSHOT:+ and $UPLOADS_SNAPSHOT}"
    echo "  Both can be deleted once you have checked BlackVault (they belong to the app user: use sudo on Linux)."
  } >&2
  exit 0
fi

# ── 6. The restore failed: put the snapshot back ──────────────
echo "" >&2
echo "The restore failed (exit $RC; the reason is above). Putting the database and the uploads back from the snapshot..." >&2
ROLLED_BACK=1
rollback_database || ROLLED_BACK=0
rollback_uploads || ROLLED_BACK=0
trap - INT TERM HUP

if [ "$ROLLED_BACK" -ne 1 ]; then
  printf 'ERROR: %s\n' "the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started." >&2
  print_manual_recovery
  exit 1
fi
echo "Starting BlackVault..." >&2
if ! start_app; then
  die "the restore failed and everything was put back from the snapshot ($DB_SNAPSHOT), so nothing is changed; but BlackVault did not start again. Start it by hand: $COMPOSE up -d"
fi
die "the restore failed (the reason is above). The database and the uploads were put back from the snapshot taken before it ($DB_SNAPSHOT), so nothing is changed. BlackVault was started again."
