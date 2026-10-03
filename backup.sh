#!/bin/bash
# backup.sh — make, or verify, a full BlackVault backup from the host.
# (full-backups spec §2, docs/superpowers/specs/2026-10-02-full-backups-design.md)
# backup.bat is the Windows twin: change them together.
#
#   ./backup.sh [--passphrase-file <path>] [--keep <n>]      make a backup
#   ./backup.sh --verify <file> [--passphrase-file <path>]   check one
#
# A full backup is ONE passphrase-sealed file, blackvault-full-<time>.bvb,
# holding the database records and every uploaded photo and document. It is
# written by the app itself, inside its container, into the backup folder:
# BLACKVAULT_BACKUP_DIR in .env, by default <DATA_DIR>/backups (./data/backups).
# Copy the files somewhere else; this script does not.
#
# PASSPHRASE. With --passphrase-file the file is handed to the backup program
# on its standard input, byte for byte. The program drops ONE leading UTF-8
# byte order mark and ONE trailing line ending (LF or CRLF), and refuses a
# file that is not UTF-8 text (UTF-16, for example). Without it you are asked to type the
# passphrase, without echo — twice when making a backup, once for --verify.
# The passphrase is never put on a command line or into the environment of
# any program: a file is redirected, a typed one is written to a pipe by the
# shell itself (printf is a builtin, the variable is never exported).
# With no --passphrase-file and no terminal (cron), this script stops at
# once with an error instead of waiting on a prompt nobody can answer.
#
# --keep <n> (default 7). After the new backup has been written AND verified,
# the oldest backups beyond the newest <n> are deleted. That happens inside
# the container, in the same run (the files belong to the app user, uid 1001,
# and on Linux you could not delete them yourself without sudo). If the backup
# fails, nothing is deleted. The backup program verifies every archive before
# it gives it its final name, so there is no second verify pass here.
#
# --verify <file>. Decrypts the whole archive and checks every file in it
# against its manifest. Writes nothing. <file> is a file name in the backup
# folder, or a path to a file in that folder.
#
# HOW IT RUNS.
#   app running   docker compose exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs ...
#   app stopped   docker compose run --rm -T blackvault node dist/scripts/full-backup.mjs ...
# The first form names the group too (1001:1001, the app's own user and
# group). With `-u 1001` alone Docker takes the group from the image's
# /etc/passwd, where that user's primary group is nogroup (65533), and the
# backup file came out 1001:65533 instead of 1001:1001 like every other file
# the app writes.
# The second form deliberately has no `--user` and no `--no-deps`, the same
# as rotate-key.sh's one-off containers:
#   * the container must START as root, because the image's entrypoint is
#     what copies the encryption key into /run/secrets (and prepares
#     /app/backups); it then drops to the app user (uid 1001) itself. Started
#     with `--user 1001:1001` the entrypoint copies nothing
#     (scripts/docker-entrypoint.sh), and the backup could not decrypt.
#   * on PostgreSQL the backup needs the database. Without `--no-deps`,
#     Compose starts the db service and waits until it is healthy.
#
# TIME LIMIT. None by default: a backup of several GB can take a long time
# and must not be cut off. Set BLACKVAULT_BACKUP_TIMEOUT=<seconds> to stop
# waiting after that long (needs the `timeout` command).
#
# OUTPUT. On success, one line on standard output, from the backup program:
#   BLACKVAULT_FULL_BACKUP_OK file=<name> files=<n> bytes=<n> archive_bytes=<n> skipped=<n> unreadable=<n>
#   BLACKVAULT_FULL_BACKUP_VERIFIED file=<name> files=<n> bytes=<n> archive_bytes=<n>
# Warnings and errors go to standard error; lines starting WARNING: deserve
# a look even when the exit code is 0.
#
# EXIT CODE. 0 ok · 1 failed · 2 another backup is already running.
set -o pipefail
# No `set -e` on purpose: every failure below is handled where it happens and
# ends in exit 1 with one line on standard error. With -e, a command failing
# unexpectedly with status 2 would be reported as "already running".

USAGE="Usage: ./backup.sh [--passphrase-file <path>] [--keep <n>]  |  ./backup.sh --verify <file> [--passphrase-file <path>]"

# ── 0. The install ────────────────────────────────────────────
# Paths given on the command line are relative to where the user ran this
# script from, not to the folder it lives in. .env and docker-compose.yml
# live next to this script: everything else runs from there.
# scripts/backup-common.sh holds what this script shares with restore.sh.
ORIG_PWD=$PWD
cd "$(dirname "$0")" || { printf 'ERROR: %s\n' "cannot change to the folder backup.sh is in." >&2; exit 1; }
for f in scripts/compose-provider.sh scripts/backup-common.sh; do
  [ -f "./$f" ] || { printf 'ERROR: %s\n' "$f is missing; run backup.sh from a complete BlackVault folder." >&2; exit 1; }
done
# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh
# shellcheck source=scripts/backup-common.sh
. ./scripts/backup-common.sh

# ── 1. Arguments ──────────────────────────────────────────────
# An unknown argument is never echoed back: it could be a passphrase typed
# on the command line by mistake.
PASSFILE=""
KEEP=""
VERIFY=""
MODE="backup"
while [ $# -gt 0 ]; do
  case "$1" in
    --passphrase-file)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || die "--passphrase-file needs a path. $USAGE"
      PASSFILE=$2
      shift 2
      ;;
    --keep)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || die "--keep needs a number. $USAGE"
      KEEP=$2
      shift 2
      ;;
    --verify)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || die "--verify needs a file. $USAGE"
      VERIFY=$2
      MODE="verify"
      shift 2
      ;;
    -h | --help)
      printf '%s\n' "$USAGE"
      exit 0
      ;;
    *)
      die "unknown argument. $USAGE"
      ;;
  esac
done

if [ "$MODE" = "verify" ]; then
  [ -z "$KEEP" ] || die "--keep cannot be used with --verify. $USAGE"
else
  KEEP=${KEEP:-7}
  case "$KEEP" in
    *[!0-9]*) die "--keep needs a whole number, 1 or more." ;;
  esac
  [ "${#KEEP}" -le 6 ] || die "--keep needs a whole number from 1 to 100000."
  KEEP=$((10#$KEEP))
  { [ "$KEEP" -ge 1 ] && [ "$KEEP" -le 100000 ]; } || die "--keep needs a whole number from 1 to 100000."
fi

# ── 2. The passphrase source, then Docker Compose and the backup folder ──
bv_check_passphrase_source

bv_compose_setup

# ── 3. --verify <file>: a name in the backup folder, or a path into it ──
ENGINE_ARGS=()
if [ "$MODE" = "verify" ]; then
  bv_backup_file_name --verify "$VERIFY"
  VERIFY_NAME=$BACKUP_FILE_NAME
  ENGINE_ARGS=(--verify "$VERIFY_NAME")
else
  ENGINE_ARGS=(--keep "$KEEP")
fi

# ── 4. The passphrase (prompt only; a file is redirected in step 6) ──
if [ -z "$PASSFILE" ]; then
  [ "$MODE" = "verify" ] || echo "Choose the passphrase for this backup. Without it the backup cannot be opened." >&2
  bv_echo_off
  if [ "$MODE" = "verify" ]; then
    ask_passphrase "Backup passphrase: "
  else
    # Ruling R19: a typo here would seal a backup nobody can open. Ask twice.
    ask_passphrase "Backup passphrase: "
    FIRST=$PASSPHRASE
    ask_passphrase "Repeat the passphrase: "
    if [ "$FIRST" != "$PASSPHRASE" ]; then
      FIRST=""
      PASSPHRASE=""
      die "the two passphrases do not match. Nothing was done."
    fi
    FIRST=""
  fi
  restore_tty
fi

# ── 5. Running or stopped ─────────────────────────────────────
# See "HOW IT RUNS" at the top for why the one-off container has no --user
# and no --no-deps.
RUNNING=$($COMPOSE ps --status running -q blackvault 2>/dev/null) || RUNNING=""
if [ -n "$RUNNING" ]; then
  CMD=($COMPOSE exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs "${ENGINE_ARGS[@]}")
else
  CMD=($COMPOSE run --rm -T blackvault node dist/scripts/full-backup.mjs "${ENGINE_ARGS[@]}")
fi

LIMIT=${BLACKVAULT_BACKUP_TIMEOUT:-}
if [ -n "$LIMIT" ]; then
  case "$LIMIT" in
    *[!0-9]*) die "BLACKVAULT_BACKUP_TIMEOUT must be a number of seconds." ;;
  esac
  if [ "$((10#$LIMIT))" -gt 0 ]; then
    command -v timeout >/dev/null 2>&1 || die "BLACKVAULT_BACKUP_TIMEOUT is set but the 'timeout' command is not installed. Nothing was done."
    CMD=(timeout "$((10#$LIMIT))" "${CMD[@]}")
  else
    LIMIT=""
  fi
fi

# ── 6. Run it, the passphrase on standard input ───────────────
{ [ -n "$PASSFILE" ] || [ "$MODE" = "verify" ]; } || echo "Making the backup. A large uploads folder can take a while..." >&2
bv_run_with_passphrase
PASSPHRASE=""

case "$RC" in
  0) exit 0 ;;
  # The backup program printed why (one `full-backup: ...` line) for 1 and 2.
  1) exit 1 ;;
  2) exit 2 ;;
  124)
    [ -n "$LIMIT" ] && die "the backup did not finish within $LIMIT seconds (BLACKVAULT_BACKUP_TIMEOUT). It may still be running inside the container."
    die "the backup command ended unexpectedly (exit $RC); see the output above."
    ;;
  *) die "the backup command ended unexpectedly (exit $RC); see the output above." ;;
esac
