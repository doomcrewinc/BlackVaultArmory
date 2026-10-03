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
#      Before the stop, a running BlackVault is asked whether a full backup
#      is in progress. If one is, the script stops here instead: nothing was
#      changed and BlackVault keeps running. Run it again afterwards.
#   4. Restores, in a one-off container: the backup's files are written
#      (encrypted with this install's key) into uploads/.restore-<time>/, the
#      database records are replaced in one transaction, then the current
#      images/ and documents/ folders are moved into
#      uploads/.pre-restore-<time>/ and the restored ones take their place.
#   5. Starts BlackVault.
# IF STEP 4 FAILS, for any reason, the install is put back automatically,
# BlackVault is started again, and this script exits 1: the install is as it
# was. The uploads are always put back (and checked against the snapshot).
# The DATABASE is put back from the snapshot only if the restore had reached
# its database step: the restore program leaves a marker,
# <uploads>/.restore-<time>.db-started, just before that step. No marker
# means the database was never touched, and it is left alone. If the
# rollback itself fails, BlackVault is NOT started.
#
# THE RECOVERY FILE. Before step 4 this script prints, and writes to
# backups/restore-<time>-RECOVERY.txt (and flushes to disk with `sync`),
# where the snapshot is and the exact commands that put it back by hand. If this script dies (the terminal
# closes, the machine restarts), that file is what tells you the install may
# be half restored and how to undo it. It is deleted when the restore
# succeeds or the automatic rollback has worked; while one exists, this
# script refuses to start.
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
#   docker compose run --rm -T --name blackvault-restore-<time> blackvault node dist/scripts/full-restore.mjs --stamp <time> <name>
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
# One exception: if the restore program had finished and only its exit status
# was lost (its container died on the way out), this script still exits 0,
# with a WARNING; that line, and the RESTORE entry in the audit log, may then
# be missing.
#
# INTERRUPTED (Ctrl-C, a closed terminal, kill). Before the restore has
# started: BlackVault is started again and nothing was changed. While it
# runs: the restore container is stopped by name and seen to be gone, then
# the recovery text is shown; nothing is rolled back automatically.
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
# docker compose takes DATA_DIR from the shell before .env; scripts/db-snapshot.sh
# and this script read .env. If the two differ, the snapshot would be of one
# install and the restore of another.
if [ -n "${DATA_DIR+set}" ] && [ "$DATA_DIR" != "$(env_value DATA_DIR)" ]; then
  die "DATA_DIR is set in this shell and is not the DATA_DIR in .env, so docker compose and the snapshot would use different folders. Run 'unset DATA_DIR' first. Nothing was done."
fi
# Ruling R25: an earlier restore that did not end cleanly left its recovery
# file. Never start a second restore on top of a possibly half-restored install.
for f in backups/restore-*-RECOVERY.txt; do
  [ -e "$f" ] || continue
  die "an earlier restore did not finish cleanly: $PWD/$f is still there. Read it: it says how to put the install back as it was. If BlackVault is running and you have checked it, delete that file instead. Then run the restore again. Nothing was done."
done
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
RECOVERY_FILE="backups/restore-$STAMP-RECOVERY.txt"
# The one-off restore container gets a name, so that it can be stopped by name.
CONTAINER="blackvault-restore-$STAMP"
# docker-compose.yml mounts <DATA_DIR>/uploads at /app/uploads. The restore
# program's marker and its .pre-restore folder are here, seen from the host
# (restore_state says when the host is asked, and when a container is).
HOST_UPLOADS_DIR="$HOST_DATA_DIR/uploads"
MARKER_HOST="$HOST_UPLOADS_DIR/.restore-$STAMP.db-started"

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
PG_NEW=(-d postgres -c "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault")
PG_LOAD=(-d blackvault_rollback --single-transaction -f -)
PG_SWAP=(-d postgres -c "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault")

# PostgreSQL: the dump is loaded into a NEW database first, in one
# transaction. Only when that worked is the live database dropped and the
# new one given its name, so a dump that does not load leaves the live
# database alone.
rollback_postgres() {
  $COMPOSE up -d --wait db >&2 || return 1
  "${PSQL[@]}" "${PG_NEW[@]}" >&2 || return 1
  "${PSQL[@]}" "${PG_LOAD[@]}" < "$DB_SNAPSHOT" > /dev/null || return 1
  "${PSQL[@]}" "${PG_SWAP[@]}" >&2 || return 1
}

rollback_database() {
  if [ "$PROVIDER" = "sqlite" ]; then
    "${SNAPSHOT_RESTORE[@]}" "${SQLITE_ROLLBACK_ARGS[@]}" >&2
  else
    rollback_postgres
  fi
}

UPLOADS_ROLLBACK_ARGS=()
# With the uploads folder and the stamp, the script itself refuses to touch
# the database unless the restore's marker exists (ruling R28).
SQLITE_ROLLBACK_ARGS=()
rollback_uploads() {
  "${SNAPSHOT_RESTORE[@]}" "${UPLOADS_ROLLBACK_ARGS[@]}" >&2
}

# Ruling R24. What the restore program left behind:
#   started    its marker exists: the database step was reached, so the
#              database may hold the backup's records.
#   complete   no marker, but .pre-restore-<time> holds a previous folder: the
#              program removes its marker only after everything is in place,
#              so the restore FINISHED and only its exit status was lost.
#   untouched  neither: the database step was never reached.
#   unknown    neither a container nor the host could say. Nothing is rolled
#              back blindly: BlackVault is not started and the recovery file
#              says what to do.
# The answer comes from INSIDE a container, as root: scripts/snapshot-restore.sh
# `state` is the rule itself, and it sees what the restore program wrote. The
# host cannot be relied on: on Linux the program creates .pre-restore-<time>
# with mode 0700 as uid 1001, so the user running this script can see that it
# exists but not what is in it. The host is looked at only when the container
# could not be asked, and it answers only what it can actually see: a
# .pre-restore-<time> that exists but cannot be entered is `unknown`, never
# `untouched`.
# scripts/snapshot-restore.sh applies the same rule again by itself (ruling
# R28): its `uploads` mode changes nothing after a finished restore, whatever
# this function answered.
container_restore_state() {
  local seen
  seen=$("${SNAPSHOT_RESTORE[@]}" state /app/uploads "$STAMP" 2> /dev/null | tr -d '[:space:]') || seen=""
  case "$seen" in
    started | complete | untouched) echo "$seen" ;;
    *) echo unknown ;;
  esac
}

host_can_enter() {
  [ -d "$1" ] && [ -r "$1" ] && [ -x "$1" ]
}

host_restore_state() {
  local pre="$HOST_UPLOADS_DIR/.pre-restore-$STAMP"
  if ! host_can_enter "$HOST_UPLOADS_DIR"; then
    echo unknown
  elif [ -e "$MARKER_HOST" ]; then
    echo started
  elif [ ! -e "$pre" ] && [ ! -L "$pre" ]; then
    echo untouched
  elif ! host_can_enter "$pre"; then
    echo unknown
  elif { [ -d "$pre/images" ] && [ ! -L "$pre/images" ]; } || { [ -d "$pre/documents" ] && [ ! -L "$pre/documents" ]; }; then
    echo complete
  else
    echo untouched
  fi
}

restore_state() {
  local seen
  seen=$(container_restore_state)
  [ "$seen" != "unknown" ] || seen=$(host_restore_state)
  echo "$seen"
}

# Ruling R25. Where the snapshot is and exactly what to run, for when this
# script cannot do it itself. Printed before the restore starts, and written
# to $RECOVERY_FILE. Every path is quoted for pasting into a shell.
recovery_text() {
  echo "BlackVault restore $STAMP: RECOVERY"
  echo ""
  echo "Written by restore.sh just before it started restoring $NAME."
  echo "restore.sh deletes this file when the restore has succeeded, or when it has"
  echo "put everything back itself. If you are reading this and restore.sh is no"
  echo "longer running (it was killed, the terminal closed, the machine restarted),"
  echo "BlackVault is stopped and the install may be HALF RESTORED. Do not just start"
  echo "it: put the install back as it was with the commands below."
  echo ""
  echo "The install as it was before the restore is in this snapshot:"
  echo "  database: $DB_SNAPSHOT"
  echo "  uploads:  ${UPLOADS_SNAPSHOT:-(no uploads snapshot was recorded)}"
  echo ""
  echo "Run these from $(bv_shell_quote "$PWD"), in this order."
  echo ""
  echo "1. Make sure the restore is no longer running. The second command must list"
  echo "   nothing before you go on ('No such container' from the first is fine):"
  echo "  docker stop $CONTAINER"
  echo "  docker ps -a --filter name=$CONTAINER"
  echo "  $COMPOSE stop blackvault"
  echo ""
  echo "2. See how far the restore got. This prints one word:"
  echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" state /app/uploads "$STAMP")"
  echo "   complete   The restore FINISHED: the records and the files are the backup's."
  echo "              There is nothing to put back. (The program's OK line and the"
  echo "              RESTORE entry in the audit log may be missing.) The commands of"
  echo "              step 3 change nothing in this state; you can go to step 4."
  echo "   started    The restore had reached the database and did not finish. Step 3"
  echo "              puts the photos, the documents and the database back."
  echo "   untouched  The restore never reached the database. Step 3 only removes its"
  echo "              work folder and checks the photos and documents."
  echo ""
  # Step 3 is printed as ONE && chain. clear-marker removes the only thing
  # that says "the database step was reached"; run after a line that failed,
  # it would make a half-rolled-back install read as untouched or finished.
  if [ "$PROVIDER" = "sqlite" ]; then
    echo "3. Put it back. These lines are ONE command (each ends in &&): a line runs"
    echo "   only if every line above it worked, so the marker is cleared (the last"
    echo "   line) only when everything is back. Paste them together. If it stops with"
    echo "   an ERROR, fix what it says and run all of them again; never run the last"
    echo "   line by itself. Each line looks at the state itself and changes only what"
    echo "   that state needs."
    echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" "${UPLOADS_ROLLBACK_ARGS[@]}") &&"
    echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" "${SQLITE_ROLLBACK_ARGS[@]}") &&"
    echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" clear-marker /app/uploads "$STAMP")"
  else
    echo "3. Put it back. Step 2 says which of the two to run."
    echo "   PostgreSQL: the next six lines ONLY if step 2 printed: started"
    echo "   (in any other state they would replace a database the restore did not"
    echo "   leave half done). They are ONE command (each ends in &&): a line runs only"
    echo "   if every line above it worked, so the marker is cleared (the last line)"
    echo "   only when everything is back. Paste them together. If it stops with an"
    echo "   ERROR, fix what it says and run all of them again; never run the last"
    echo "   line by itself."
    echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" "${UPLOADS_ROLLBACK_ARGS[@]}") &&"
    echo "  $COMPOSE up -d --wait db &&"
    echo "  $(bv_quote_cmd "${PSQL[@]}" "${PG_NEW[@]}") &&"
    echo "  $(bv_quote_cmd "${PSQL[@]}" "${PG_LOAD[@]}") < $(bv_shell_quote "$DB_SNAPSHOT") &&"
    echo "  $(bv_quote_cmd "${PSQL[@]}" "${PG_SWAP[@]}") &&"
    echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" clear-marker /app/uploads "$STAMP")"
    echo "   If step 2 printed untouched or complete, this line and nothing else (it"
    echo "   removes the restore's work folder and checks the photos and documents):"
    echo "  $(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" "${UPLOADS_ROLLBACK_ARGS[@]}")"
  fi
  echo ""
  echo "4. Start BlackVault, check it, then delete this file:"
  echo "  $COMPOSE up -d"
  echo "  rm $(bv_shell_quote "$RECOVERY_FILE")"
}

# This run's two names must be free. If one exists (a second run in the same
# second, a clock set back), the restore program would refuse — and a
# leftover .pre-restore folder would then read as "the restore finished".
# Looked at from the host when the host can enter the uploads folder (a name
# is visible there even when the folder behind it is not); otherwise the
# container is asked, as restore_state does.
if host_can_enter "$HOST_UPLOADS_DIR" || [ ! -e "$HOST_UPLOADS_DIR" ]; then
  for f in "$HOST_UPLOADS_DIR/.pre-restore-$STAMP" "$MARKER_HOST"; do
    if [ -e "$f" ]; then
      PASSPHRASE=""
      die "$f already exists (left by an earlier restore with the same time stamp). Wait a second and run the restore again. Nothing was changed; BlackVault was not stopped."
    fi
  done
else
  # The container mounts backups/; if Docker had to create that folder it
  # would belong to root, and the snapshot could not be written into it.
  mkdir -p backups 2> /dev/null
  case "$(container_restore_state)" in
    untouched) ;;
    started | complete)
      PASSPHRASE=""
      die "an earlier restore with the same time stamp ($STAMP) left its .pre-restore folder or its marker in the uploads folder. Wait a second and run the restore again. Nothing was changed; BlackVault was not stopped."
      ;;
    *)
      PASSPHRASE=""
      die "could not check the uploads folder $HOST_UPLOADS_DIR for what an earlier restore may have left: it cannot be entered from here, and asking inside a container failed. Nothing was changed; BlackVault was not stopped."
      ;;
  esac
fi

# A full backup that is running right now (the Settings button, backup.sh,
# a cron job) would be ended by the stop below, and the restore program,
# which takes the same lock, would say "already running" only after the
# snapshot. So the running app container is asked first, and the rule for
# "is that lock live" stays the engine's own (scripts/entry/full-backup.ts
# --lock-status: exit 0 free, exit 2 held, one line naming the holder).
# Any other answer means the question failed, not that a backup runs — an
# image from before --lock-status answers 1 — and never blocks a restore.
# With BlackVault stopped there is no container to ask and nothing the stop
# could end; the restore program's own lock still applies.
if [ -n "$($COMPOSE ps --status running -q blackvault 2> /dev/null)" ]; then
  LOCK_STATUS=$($COMPOSE exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs --lock-status < /dev/null 2>&1)
  LOCK_RC=$?
  if [ "$LOCK_RC" -eq 2 ]; then
    PASSPHRASE=""
    printf '%s\n' "$LOCK_STATUS" >&2
    die "a full backup is running (the line above names it), so the restore did not start. Nothing was changed; BlackVault was not stopped. Run the restore again when the backup has finished."
  elif [ "$LOCK_RC" -ne 0 ]; then
    [ -z "$LOCK_STATUS" ] || printf '%s\n' "$LOCK_STATUS" >&2
    echo "WARNING: could not check whether a full backup is running (exit $LOCK_RC; an image from before this check answers like that). If one is running, stopping BlackVault ends it. Going on with the restore." >&2
  fi
fi

# ── 4. Stop the app, snapshot the database and the uploads ────
# Interrupted before the restore itself has started: nothing was changed.
interrupted_early() {
  trap - INT TERM HUP
  PASSPHRASE=""
  # Nothing was changed, so nothing may be left that says otherwise: not the
  # recovery file (it would block the next restore), not db-snapshot.sh's
  # marker for update.sh.
  rm -f "$RECOVERY_FILE" backups/.uploads-snapshot-marker
  if start_app; then
    die "interrupted before the restore started. Nothing was changed; BlackVault was started again."
  fi
  die "interrupted before the restore started. Nothing was changed, but BlackVault is STOPPED: start it with: $COMPOSE up -d"
}
trap interrupted_early INT TERM HUP

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
  trap - INT TERM HUP
  PASSPHRASE=""
  start_app || echo "WARNING: BlackVault did not start again; start it by hand: $COMPOSE up -d" >&2
  die "the snapshot before the restore failed (see above), so the restore did not start. Nothing was changed."
fi
if [ -z "$DB_SNAPSHOT" ] || [ ! -f "$DB_SNAPSHOT" ]; then
  trap - INT TERM HUP
  PASSPHRASE=""
  start_app || echo "WARNING: BlackVault did not start; start it by hand: $COMPOSE up -d" >&2
  die "there is no database to snapshot yet, so a failed restore could not be undone. Start BlackVault once ($COMPOSE up -d), wait until it is up, then run the restore again. Nothing was changed."
fi
SQLITE_ROLLBACK_ARGS=(sqlite "/bv-backups/$(basename "$DB_SNAPSHOT")" /app/data/vault.db /app/uploads "$STAMP")
UPLOADS_ROLLBACK_ARGS=(uploads /app/uploads "$STAMP")
[ -z "$UPLOADS_SNAPSHOT" ] || UPLOADS_ROLLBACK_ARGS+=("/bv-backups/$(basename "$UPLOADS_SNAPSHOT")")

# ── 5. The recovery file, then the restore ────────────────────
if ! (umask 077 && recovery_text > "$RECOVERY_FILE"); then
  trap - INT TERM HUP
  PASSPHRASE=""
  rm -f "$RECOVERY_FILE"
  start_app || echo "WARNING: BlackVault did not start again; start it by hand: $COMPOSE up -d" >&2
  die "could not write the recovery file $RECOVERY_FILE, so the restore did not start. Nothing was changed."
fi
# The recovery file has to survive a power cut during the restore: it is all
# that says the install may be half restored. bash cannot fsync one file, and
# nothing beyond the standard tools is assumed here (Linux, macOS), so this
# is the plain `sync` command: it writes out everything that is waiting,
# which includes this file, its folder and the snapshot just taken.
sync || echo "WARNING: 'sync' failed, so $RECOVERY_FILE may not be on the disk yet. After a power cut during the restore it could be missing: the snapshot it names would still be in backups/." >&2
{
  echo ""
  echo "If this script is interrupted from here on, the install may be half restored."
  echo "How to put it back is in $PWD/$RECOVERY_FILE:"
  echo "----------------------------------------------------------------------"
  cat "$RECOVERY_FILE"
  echo "----------------------------------------------------------------------"
  echo ""
} >&2

# Interrupted while the restore runs. The restore container may still be
# working: it is stopped, and seen to be gone, BEFORE anyone is told to run
# the rollback commands — a restore that commits after a rollback would undo it.
interrupted() {
  trap - INT TERM HUP
  PASSPHRASE=""
  local left
  printf 'ERROR: %s\n' "the restore was interrupted. BlackVault is stopped and the install may be half restored." >&2
  echo "Stopping the restore container $CONTAINER..." >&2
  # The docker client this script started goes first, and is waited for: a
  # client that has not created the container yet would otherwise create it
  # after `docker stop` found nothing to stop.
  if [ -n "$BV_CLIENT_PID" ]; then
    kill "$BV_CLIENT_PID" 2> /dev/null
    wait "$BV_CLIENT_PID" 2> /dev/null
  fi
  docker stop "$CONTAINER" > /dev/null 2>&1
  if left=$(docker ps -aq --filter "name=^${CONTAINER}\$" 2> /dev/null) && [ -z "$left" ]; then
    echo "The restore container is gone." >&2
  else
    echo "WARNING: could not confirm that the restore container $CONTAINER has stopped. Do NOT run the commands of steps 2 to 4 until step 1's 'docker ps' lists nothing." >&2
  fi
  echo "To put the install back as it was, follow $PWD/$RECOVERY_FILE:" >&2
  cat "$RECOVERY_FILE" >&2
  exit 1
}
trap interrupted INT TERM HUP

echo "Restoring $NAME. A large backup can take a while..." >&2
CMD=($COMPOSE run --rm -T --name "$CONTAINER" blackvault node dist/scripts/full-restore.mjs --stamp "$STAMP" "$NAME")
bv_run_with_passphrase_waited
PASSPHRASE=""
trap - INT TERM HUP

STATE=""
if [ "$RC" -ne 0 ]; then
  STATE=$(restore_state)
  if [ "$STATE" = "complete" ]; then
    echo "WARNING: the restore program ended with exit $RC, but it had FINISHED: its marker is gone and the previous folders are in .pre-restore-$STAMP. Nothing is rolled back. Its BLACKVAULT_FULL_RESTORE_OK line and the RESTORE entry in the audit log may be missing." >&2
  fi
fi

if [ "$RC" -eq 0 ] || [ "$STATE" = "complete" ]; then
  rm -f "$RECOVERY_FILE" || echo "WARNING: could not delete $RECOVERY_FILE; delete it by hand, or the next restore will refuse to start." >&2
  if [ -e "$MARKER_HOST" ]; then
    echo "WARNING: the restore finished but left its marker $MARKER_HOST. It can be deleted (it belongs to the app user: use sudo on Linux)." >&2
  fi
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

# ── 6. The restore failed: put the install back ───────────────
# The uploads FIRST: that removes the restore's staging folder, which frees
# the space the database copy may need on a full disk. Then the database,
# only if the restore had reached it (ruling R24).
echo "" >&2
ROLLED_BACK=1
if [ "$STATE" = "unknown" ]; then
  echo "The restore failed (exit $RC; the reason is above), and how far it got could not be found out: asking inside a container failed, and the uploads folder $HOST_UPLOADS_DIR (or its .pre-restore-$STAMP) cannot be looked into from here. Nothing is rolled back blindly." >&2
  ROLLED_BACK=0
elif [ "$STATE" = "started" ]; then
  echo "The restore failed (exit $RC; the reason is above) after it had reached the database. Putting the uploads and the database back from the snapshot..." >&2
  rollback_uploads || ROLLED_BACK=0
  rollback_database || ROLLED_BACK=0
else
  echo "The restore failed (exit $RC; the reason is above) before it reached the database: the database is left alone. Checking the uploads against the snapshot..." >&2
  rollback_uploads || ROLLED_BACK=0
fi

if [ "$ROLLED_BACK" -ne 1 ]; then
  printf 'ERROR: %s\n' "the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started. What to do is in $PWD/$RECOVERY_FILE:" >&2
  cat "$RECOVERY_FILE" >&2
  exit 1
fi
if [ "$STATE" = "started" ]; then
  "${SNAPSHOT_RESTORE[@]}" clear-marker /app/uploads "$STAMP" >&2 ||
    echo "WARNING: everything was put back, but the marker $MARKER_HOST could not be removed. Delete it by hand (it belongs to the app user: use sudo on Linux)." >&2
fi
rm -f "$RECOVERY_FILE" || echo "WARNING: could not delete $RECOVERY_FILE; delete it by hand, or the next restore will refuse to start." >&2
echo "Starting BlackVault..." >&2
if [ "$STATE" = "started" ]; then
  DONE="The database and the uploads were put back from the snapshot taken before it ($DB_SNAPSHOT), so nothing is changed."
else
  DONE="It had not reached the database, which was not touched; the uploads were checked against the snapshot. Nothing is changed."
fi
if ! start_app; then
  die "the restore failed (the reason is above). $DONE But BlackVault did not start again: start it by hand: $COMPOSE up -d"
fi
die "the restore failed (the reason is above). $DONE BlackVault was started again."
