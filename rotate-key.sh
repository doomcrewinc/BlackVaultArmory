#!/bin/bash
set -Eeo pipefail

# rotate-key.sh — rotate BlackVault's field-encryption key.
# (field-encryption spec §3 "Rotation",
#  docs/superpowers/specs/2026-09-30-field-encryption-design.md)
#
# Stops the app, snapshots the database, generates a new key, runs the
# rotation inside the container in one transaction, and only then swaps the
# key files and restarts.
#
# Fix round 1 (task-6-review.md, C1): scripts/rotate-encryption-key.mjs can
# exit non-zero AFTER its transaction already committed (a disconnect error,
# a broken stdout pipe, the container dying during `--rm` cleanup). Treating
# every non-zero `compose run` as "nothing changed" — the original
# behaviour — could delete the only copy of a key the database is already
# encrypted with. So a non-zero rotation run is followed by a read-only
# --probe (OLD/NEW/NEITHER, by which key opens the database's key check)
# before anything is deleted or restarted: NEW completes the swap exactly as
# a normal success would, OLD sets the unused new key aside (renamed to
# .new.unused-<ts>, never deleted — fix round 2, N2) and restarts on the
# old one, and NEITHER (or the probe itself failing) keeps every key
# file untouched, does NOT start the app, and prints exact recovery
# commands — never a silent guess.
#
# `PHASE` + the ERR trap below (fix round 1, I1) catch UNEXPECTED failures
# in the handful of commands that are not already wrapped in an explicit
# success/failure check (stopping the app, the two key-file renames, the
# restart after a successful swap) and print recovery text for the exact
# state the script reached — `set -e` alone exited those silently before.

# .env and docker-compose.yml live next to this script: always run from here.
cd "$(dirname "$0")"

echo "╔══════════════════════════════════════╗"
echo "║   BlackVault — Key Rotation          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# shellcheck source=scripts/compose-provider.sh
. ./scripts/compose-provider.sh

KEY_FILE="secrets/blackvault_encryption_key"
NEW_KEY_FILE="secrets/blackvault_encryption_key.new"
# I2: a timestamped name, never the bare "secrets/blackvault_encryption_key.old" —
# the pre-rotation snapshot (step 3) is sealed under THIS run's old key, so a
# second rotation must never silently overwrite the file that opens it.
ROTATE_TS="$(date -u +%Y%m%d-%H%M%S)"
OLD_KEY_FILE="secrets/blackvault_encryption_key.old-$ROTATE_TS"
[ -e "$OLD_KEY_FILE" ] && OLD_KEY_FILE="${OLD_KEY_FILE}-$$" # pathological same-second collision
# Fix round 2 (N2, ruling): the wrappers NEVER delete a key file that may
# have been handed to the rotation. When the probe confirms OLD, .new is
# renamed to this name instead of removed, in case the probe was wrong (e.g.
# an orphaned rotation container still running — task-6-rereview.md N2).
UNUSED_KEY_FILE="secrets/blackvault_encryption_key.new.unused-$ROTATE_TS"
[ -e "$UNUSED_KEY_FILE" ] && UNUSED_KEY_FILE="${UNUSED_KEY_FILE}-$$"

PHASE="init"

# I1: the catch-all for a command that fails WITHOUT an explicit if/else
# around it — the only such commands below are `$COMPOSE stop`, the two
# key-file `mv`s, and the post-swap `$COMPOSE start`. Every other failure
# path (missing/failing snapshot, keygen, writing .new, the rotation run
# itself, every restart-on-the-old-key) is the CONDITION of an if/||, so
# with `set -E` the trap still does not fire for it — not in this shell and
# not in the $(...) / ( ... ) subshells it runs (fix round 2, N3: before,
# `NEW_KEY=$(generate_key)` and the `( umask 077; printf ... )` write ran
# bare, so the trap pre-empted their checks and left the app stopped). Each
# prints its own message before `exit 1`, which never fires ERR.
on_err() {
  local code=$?
  case "$PHASE" in
    stop)
      echo ""
      echo "ERROR: could not stop BlackVault (exit $code). Nothing was changed."
      ;;
    swap1)
      echo ""
      echo "ERROR: rotation succeeded, but renaming the key files failed (exit $code)."
      echo "       $KEY_FILE should still hold the OLD key, unchanged."
      echo "       The database itself is now encrypted with the NEW key, in $NEW_KEY_FILE."
      # N1: move the OLD key aside FIRST — it is the only key that opens
      # the pre-rotation snapshot taken in step 3.
      echo "       Recover by hand, then restart:"
      echo "         mv $KEY_FILE $OLD_KEY_FILE"
      echo "         mv $NEW_KEY_FILE $KEY_FILE"
      echo "         $COMPOSE start blackvault"
      echo "       Back up $KEY_FILE once BlackVault is confirmed working, and keep"
      echo "       $OLD_KEY_FILE for as long as you keep the pre-rotation snapshot."
      ;;
    swap2)
      echo ""
      echo "ERROR: rotation succeeded, but finishing the key-file swap failed (exit $code)."
      echo "       $KEY_FILE is now MISSING. $OLD_KEY_FILE holds the ORIGINAL (old) key."
      echo "       $NEW_KEY_FILE holds the key the database is now actually encrypted with."
      echo "       Recover by hand, then restart:"
      echo "         mv $NEW_KEY_FILE $KEY_FILE"
      echo "         $COMPOSE start blackvault"
      echo "       Back up $KEY_FILE once BlackVault is confirmed working."
      ;;
    restart-after-swap)
      # M1: the rotation and the file swap both already succeeded — only the
      # restart failed. Still say so, and still print the backup reminder.
      echo ""
      echo "Key rotation succeeded and the key files were swapped, but BlackVault"
      echo "failed to restart (exit $code)."
      echo "Back up $KEY_FILE now — the pre-rotation database snapshot in backups/ is"
      echo "encrypted with the OLD key, now at $OLD_KEY_FILE; keep that file for as long"
      echo "as you keep that snapshot."
      echo "Start BlackVault by hand once you've checked the logs: $COMPOSE start blackvault"
      ;;
    *)
      echo ""
      echo "ERROR: rotate-key.sh failed unexpectedly during phase '$PHASE' (exit $code)."
      echo "       Check the output above and the files in secrets/ by hand before trying again."
      ;;
  esac
  exit 1
}
trap on_err ERR

# ── 1. Check the current key exists ───────────────────────────
if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: $KEY_FILE not found. Nothing to rotate."
  echo "       Run ./install.sh first, or restore your key file from backup."
  exit 1
fi
# Fix round 2 (N2): a leftover .new may be the ONLY copy of the key the
# database is encrypted with (an earlier run that ended ambiguously). Never
# overwrite or delete it; refuse before anything is stopped.
if [ -e "$NEW_KEY_FILE" ]; then
  echo "ERROR: $NEW_KEY_FILE already exists, left by an earlier rotation."
  echo "       It may hold the key the database is encrypted with, so this script"
  echo "       will not overwrite it. Nothing was changed; BlackVault was not stopped."
  echo "       Resolve it first (see the earlier run's output, or check which key"
  echo "       the database uses with the --probe command in rotate-key.sh), then"
  echo "       move it out of secrets/ and run this script again."
  exit 1
fi

# Docker Compose v2.20+ (docker-compose.yml needs it). Exits before anything
# is touched when it is missing or older, so the running BlackVault keeps running.
require_compose

# Random 64 lowercase hex characters (32 bytes) from the OS CSPRNG — the same
# approach as install.sh's generate_password, sized for a field-encryption key
# (src/lib/encryption/core.mjs's generateKeyHex: randomBytes(32).toString("hex")).
generate_key() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# M3: an absolute bind source. A relative `./secrets` depends on how the
# Compose engine resolves `run -v` relative paths (version-dependent); $PWD
# is absolute the moment the `cd` above has run.
SECRETS_DIR="$PWD/secrets"

# Restarts the app on the unchanged OLD key after a failure before the
# rotation ran. The start is an if-condition so a failing restart cannot
# fire the ERR trap on top of the caller's message (fix round 2, N3).
restart_unchanged() {
  echo "Restarting BlackVault; nothing was changed."
  if ! $COMPOSE start blackvault; then
    echo "ERROR: BlackVault failed to restart. Nothing was changed; start it by"
    echo "       hand once you've checked the logs: $COMPOSE start blackvault"
  fi
}

# Runs the rotation script's read-only --probe inside the container: prints
# OLD, NEW or NEITHER on success (always exit 0), or exits non-zero (fix
# round 1, C1) when it cannot tell. Sets PROBE_ANSWER and PROBE_STATUS;
# never trips `set -e` itself (the whole call is the condition of the `if`).
run_probe() {
  if PROBE_ANSWER=$($COMPOSE run --rm -v "$SECRETS_DIR:/run/rotate:ro" blackvault \
    node scripts/rotate-encryption-key.mjs --probe \
    --old-key-file /run/rotate/blackvault_encryption_key \
    --new-key-file /run/rotate/blackvault_encryption_key.new); then
    PROBE_STATUS=0
  else
    PROBE_STATUS=$?
  fi
  PROBE_ANSWER=$(printf '%s' "$PROBE_ANSWER" | tr -d '[:space:]')
}

# Finishes a confirmed-successful rotation: renames the key files and
# restarts. Shared by the normal success path and by "the run exited
# non-zero, but the probe confirms the database is already under the new
# key" — both are the same recovery from here on.
do_swap_and_restart() {
  PHASE="swap1"
  mv "$KEY_FILE" "$OLD_KEY_FILE"
  PHASE="swap2"
  mv "$NEW_KEY_FILE" "$KEY_FILE"
  PHASE="restart-after-swap"
  $COMPOSE start blackvault
  PHASE="done"
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Key rotation complete.                                  ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "Back up $KEY_FILE now."
  echo "The pre-rotation database snapshot in backups/ is encrypted with the OLD"
  echo "key, now saved as $OLD_KEY_FILE. That file can only be opened with it, so"
  echo "keep $OLD_KEY_FILE for as long as you keep that snapshot."
}

# ── 2. Stop the app ────────────────────────────────────────────
PHASE="stop"
echo "Stopping BlackVault..."
$COMPOSE stop blackvault

# ── 3. Snapshot the database (same script the update scripts use) ──
# Ruling R4: called unconditionally; if it is missing or fails, stop here —
# never rotate without a snapshot. Task 7 creates scripts/db-snapshot.sh; until
# then this step always fails loudly, by design.
PHASE="snapshot"
echo ""
echo "Snapshotting database..."
if [ ! -f "./scripts/db-snapshot.sh" ]; then
  echo "ERROR: scripts/db-snapshot.sh is missing. Refusing to rotate the encryption"
  echo "       key without a database snapshot taken first."
  restart_unchanged
  exit 1
fi
if ! ./scripts/db-snapshot.sh; then
  echo "ERROR: database snapshot failed. See the output above."
  restart_unchanged
  exit 1
fi

# ── 4. Generate the new key ────────────────────────────────────
PHASE="keygen"
echo ""
echo "Generating new encryption key..."
# N3: `|| NEW_KEY=""` makes the substitution an or-list, so a failing
# openssl/urandom reaches the explicit check below instead of the ERR trap.
NEW_KEY=$(generate_key) || NEW_KEY=""
if [ -z "$NEW_KEY" ] || [ "${#NEW_KEY}" -ne 64 ]; then
  NEW_KEY=""
  echo "ERROR: could not generate a new encryption key (need openssl or /dev/urandom)."
  restart_unchanged
  exit 1
fi
# .new cannot exist here (checked in step 1). N3: the write is an
# if-condition, so a failure is handled here, once, not by the ERR trap.
if ! ( umask 077; printf '%s' "$NEW_KEY" > "$NEW_KEY_FILE" ); then
  NEW_KEY=""
  echo "ERROR: could not write the new key to $NEW_KEY_FILE."
  # Created by THIS run a moment ago and never handed to the rotation, so
  # the database cannot be using it: removing a partial write is safe.
  rm -f "$NEW_KEY_FILE" || true
  restart_unchanged
  exit 1
fi
NEW_KEY=""

# ── 5. Run the rotation inside the container, in one transaction ──
PHASE="rotate"
echo ""
echo "Rotating encryption key (this may take a while on a large inventory)..."
if $COMPOSE run --rm -v "$SECRETS_DIR:/run/rotate:ro" blackvault \
  node scripts/rotate-encryption-key.mjs \
  --old-key-file /run/rotate/blackvault_encryption_key \
  --new-key-file /run/rotate/blackvault_encryption_key.new
then
  # ── 6. Success: swap the key files and restart ──────────────
  do_swap_and_restart
else
  # The rotation command itself exited non-zero. That does NOT mean nothing
  # changed (fix round 1, C1): the transaction may already have committed
  # and only a step after it (closing the DB connection, a broken pipe, the
  # container dying during `--rm` cleanup) failed. Ask the database itself.
  echo ""
  echo "The rotation command exited with an error. Checking which key the database"
  echo "is actually encrypted with before touching any file..."
  PHASE="probe"
  run_probe
  case "$PROBE_ANSWER:$PROBE_STATUS" in
    NEW:0)
      echo "Confirmed: the database is already encrypted with the NEW key."
      echo "Completing the key-file swap..."
      do_swap_and_restart
      ;;
    OLD:0)
      echo "Confirmed: the database is still encrypted with the OLD key; the"
      echo "rotation did not take effect."
      PHASE="cleanup-after-failed-rotate"
      # N2 (ruling): set .new aside, never delete it.
      if mv "$NEW_KEY_FILE" "$UNUSED_KEY_FILE"; then
        echo "The unused new key was set aside as $UNUSED_KEY_FILE."
        echo "It can be deleted once BlackVault has run normally on the old key."
      else
        echo "WARNING: could not rename $NEW_KEY_FILE to $UNUSED_KEY_FILE."
        echo "         Move it out of secrets/ by hand before the next rotation."
      fi
      restart_unchanged
      exit 1
      ;;
    *)
      # Never delete .new here (fix round 1, C1): a NEITHER answer, or the
      # probe itself failing, means nobody can vouch for which key the
      # database is under. Keep every file, do not start the app, and print
      # exactly how to find out and finish by hand.
      echo ""
      echo "ERROR: could not determine whether the database is encrypted with the OLD"
      echo "       or the NEW key (probe answered '${PROBE_ANSWER:-<none>}', exit $PROBE_STATUS)."
      echo "       Nothing was deleted. BlackVault was NOT restarted."
      echo "       Do NOT delete $KEY_FILE or $NEW_KEY_FILE."
      echo "       To resolve by hand:"
      echo "         1. Make sure Docker/the database are reachable, then re-run:"
      echo "            $COMPOSE run --rm -v \"$SECRETS_DIR:/run/rotate:ro\" blackvault \\"
      echo "              node scripts/rotate-encryption-key.mjs --probe \\"
      echo "              --old-key-file /run/rotate/blackvault_encryption_key \\"
      echo "              --new-key-file /run/rotate/blackvault_encryption_key.new"
      # N1: in this state $KEY_FILE still holds the OLD key, which is the
      # only key for the pre-rotation snapshot. Move it aside first.
      echo "         2. If it answers NEW:"
      echo "              mv $KEY_FILE $OLD_KEY_FILE"
      echo "              mv $NEW_KEY_FILE $KEY_FILE"
      echo "              $COMPOSE start blackvault"
      echo "            Keep $OLD_KEY_FILE for as long as you keep the pre-rotation snapshot."
      echo "         3. If it answers OLD:"
      echo "              mv $NEW_KEY_FILE $UNUSED_KEY_FILE"
      echo "              $COMPOSE start blackvault"
      exit 1
      ;;
  esac
fi
