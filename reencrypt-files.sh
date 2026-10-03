#!/bin/bash
# reencrypt-files.sh — recover uploaded files that are encrypted with an OLD
# key, when you still have that key.
# (full-backups spec §3, docs/superpowers/specs/2026-10-02-full-backups-design.md)
# reencrypt-files.bat is the Windows twin: change them together.
#
#   ./reencrypt-files.sh --from-key-file <path>
#
# WHEN. Photos and documents open only with the key that encrypted them. If
# the uploads folder holds files from another key — a folder copied from
# another machine, an old backups/uploads-<time>/ put back after a key
# rotation — BlackVault refuses to start. With the key those files were
# encrypted with, this script re-encrypts them under THIS install's key
# (secrets/blackvault_encryption_key). Without that key the files cannot be
# recovered.
#
# <path> is the OLD key file: the same format as the install's own key file
# (64 hex characters), for example secrets/blackvault_encryption_key.old-<time>
# or the key file of the machine the folder came from. It is only read. This
# script never deletes, moves or rewrites a key file. Keep the old key file
# until BlackVault has started and your photos and documents open.
#
# WHAT IT DOES, in this order:
#   1. Checks that the old key file can be read (exit 3 if not: nothing done).
#   2. Notes whether BlackVault is running, then stops it.
#   3. Runs the re-encryption in a one-off container: every file under
#      uploads/images and uploads/documents that is encrypted with the old key
#      is decrypted with it, encrypted with the current key and replaced in
#      one step (written beside it, then renamed over it). Files already
#      under the current key are skipped, so running this twice is safe.
#      Files under any other key, and files that are not encrypted, are left
#      as they are; each one under another key gets a WARNING line.
#   4. Starts BlackVault again — only if it was running in step 2 — and says
#      whether it did.
# It deletes no file, and it takes NO snapshot: the files are rewritten in
# place. Copy the uploads folder first if you want a way back. If it stops
# part-way (a full disk, a closed terminal), every file is whole, under the
# old key or the current one: run it again and it continues with the rest.
# After an interruption BlackVault stays stopped.
#
# THE OLD KEY IS A SECRET. The file is handed to the program on its standard
# input (redirected by this shell). Its content is never put on a command
# line or into the environment of any program, and never copied anywhere.
# The mechanics are backup.sh's for a passphrase file (scripts/backup-common.sh).
#
# HOW IT RUNS.
#   docker compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs
# with no `--user` and no `--no-deps`, as backup.sh's one-off container (the
# image's entrypoint places the CURRENT key as root, then drops to the app
# user, uid 1001). Stopping and starting are `docker compose stop blackvault`
# and `docker compose start blackvault`, as in rotate-key.sh.
#
# OUTPUT. One line on standard output, from the program, whenever it went
# through the uploads folder:
#   BLACKVAULT_REENCRYPT_<OK|NOTHING|FAILED> reencrypted=<n> already_current=<n> unknown_key=<n> not_encrypted=<n> failed=<n> stopped=<0|1>
# (stopped=1: it stopped before it had gone through every file; run it again.)
# Everything else goes to standard error. The last line says whether
# BlackVault was started.
#
# EXIT CODE.
#   0  at least one file was under the old key, and all of them were re-encrypted
#   3  nothing was changed: no file is under the old key (this is also what a
#      second run answers), or the old key file is missing, empty, not a key,
#      or is this install's current key
#   1  failed — or the program finished (0 or 3) but BlackVault, which was
#      running before, could not be started again; the last line says which
set -o pipefail
# No `set -e` on purpose (as in backup.sh): every failure is handled where it happens.

USAGE="Usage: ./reencrypt-files.sh --from-key-file <path>"

# ── 0. The install ────────────────────────────────────────────
# A path given on the command line is relative to where the user ran this
# script from. scripts/backup-common.sh holds what is shared with backup.sh.
ORIG_PWD=$PWD
cd "$(dirname "$0")" || { printf 'ERROR: %s\n' "cannot change to the folder reencrypt-files.sh is in. Nothing was changed." >&2; exit 1; }
for f in scripts/compose-provider.sh scripts/backup-common.sh; do
  [ -f "./$f" ] || { printf 'ERROR: %s\n' "$f is missing; run reencrypt-files.sh from a complete BlackVault folder. Nothing was changed." >&2; exit 1; }
done
# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh
# shellcheck source=scripts/backup-common.sh
. ./scripts/backup-common.sh

# ── 1. Arguments ──────────────────────────────────────────────
# An unknown argument is never echoed back: it could be a key typed on the
# command line by mistake. PASSFILE is the name scripts/backup-common.sh
# uses for the file it redirects to the program's standard input.
PASSFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-key-file)
      { [ $# -ge 2 ] && [ -n "$2" ]; } || die "--from-key-file needs a path. $USAGE"
      PASSFILE=$2
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
[ -n "$PASSFILE" ] || die "no old key file was given. $USAGE"

# ── 2. The old key file (exit 3: nothing was done), then Docker Compose ──
bv_check_secret_file "old key file" 3

bv_compose_setup

# ── 3. Stop the app ───────────────────────────────────────────
RUNNING=$($COMPOSE ps --status running -q blackvault 2>/dev/null) || RUNNING=""

# Sets STARTED to one sentence: whether BlackVault runs again. START_FAILED
# is 1 when it was running before and could not be started again: the run
# then ends with exit 1 whatever the program answered, as in rotate-key.sh.
STARTED=""
START_FAILED=""
start_if_was_running() {
  if [ -z "$RUNNING" ]; then
    STARTED="BlackVault was not running before, so it was NOT started. Start it with: $COMPOSE up -d"
  elif $COMPOSE start blackvault >&2; then
    STARTED="BlackVault was started again."
  else
    START_FAILED=1
    STARTED="BlackVault did NOT start again: check the logs ($COMPOSE logs blackvault) and start it by hand: $COMPOSE up -d"
  fi
}

# Interrupted (Ctrl-C, a closed terminal): the one-off container may still be
# working, so nothing is started here.
interrupted() {
  trap - INT TERM HUP
  printf 'ERROR: %s\n' "interrupted. Every file is whole, under the old key or the current one. BlackVault was NOT started. Run ./reencrypt-files.sh again to continue; if you would rather not, start BlackVault with: $COMPOSE up -d" >&2
  exit 1
}
trap interrupted INT TERM HUP

echo "Stopping BlackVault..." >&2
if ! $COMPOSE stop blackvault >&2; then
  trap - INT TERM HUP
  if [ -n "$RUNNING" ]; then
    die "could not stop BlackVault. Nothing was changed; BlackVault was left as it was."
  fi
  die "could not stop BlackVault. Nothing was changed; BlackVault was not running before and was NOT started."
fi

# ── 4. Re-encrypt, the old key file on standard input ─────────
echo "Re-encrypting the files that are under the old key. A large uploads folder can take a while..." >&2
CMD=($COMPOSE run --rm -T blackvault node dist/scripts/reencrypt-files.mjs)
bv_run_with_passphrase
trap - INT TERM HUP

# ── 5. Start the app again if it was running, and say so ──────
start_if_was_running
case "$RC" in
  0)
    if [ -n "$START_FAILED" ]; then
      printf 'ERROR: %s\n' "the re-encryption itself completed, and only starting BlackVault again failed. Keep the old key file until BlackVault has started and your photos and documents open. $STARTED" >&2
      exit 1
    fi
    echo "Done. Keep the old key file until BlackVault has started and your photos and documents open. $STARTED" >&2
    exit 0
    ;;
  3)
    # The program printed why (one `reencrypt-files: ...` line).
    if [ -n "$START_FAILED" ]; then
      printf 'ERROR: %s\n' "nothing was changed, and only starting BlackVault again failed. $STARTED" >&2
      exit 1
    fi
    echo "Nothing was changed. $STARTED" >&2
    exit 3
    ;;
  1)
    # Two different failures end in exit 1, and the program's own lines say
    # which: it stopped part-way (run it again: it continues), or some files
    # under the old key cannot be converted (running it again will not help).
    # This script does not see the program's standard output, so it does not
    # guess: it points at those lines.
    printf 'ERROR: %s\n' "the re-encryption did not complete. The lines above say why, and whether running ./reencrypt-files.sh again will continue or the files named there must be restored or moved out first. $STARTED" >&2
    exit 1
    ;;
  *)
    printf 'ERROR: %s\n' "the re-encryption command ended unexpectedly (exit $RC); see the output above. Every file is whole, under the old key or the current one; run ./reencrypt-files.sh again to continue. $STARTED" >&2
    exit 1
    ;;
esac
