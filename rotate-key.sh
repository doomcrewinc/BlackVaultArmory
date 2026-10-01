#!/bin/bash
set -e

# rotate-key.sh — rotate BlackVault's field-encryption key.
# (field-encryption spec §3 "Rotation",
#  docs/superpowers/specs/2026-09-30-field-encryption-design.md)
#
# Stops the app, snapshots the database, generates a new key, runs the
# rotation inside the container in one transaction, and only then swaps the
# key files and restarts. Any failure along the way restarts BlackVault on
# the OLD key and leaves the key files exactly as they were — rotation
# either fully succeeds or changes nothing.

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
OLD_KEY_FILE="secrets/blackvault_encryption_key.old"

# ── 1. Check the current key exists ───────────────────────────
if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: $KEY_FILE not found. Nothing to rotate."
  echo "       Run ./install.sh first, or restore your key file from backup."
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

# ── 2. Stop the app ────────────────────────────────────────────
echo "Stopping BlackVault..."
$COMPOSE stop blackvault

# ── 3. Snapshot the database (same function the update scripts use) ──
# Ruling R4: called unconditionally; if it is missing or fails, stop here —
# never rotate without a snapshot. Task 7 creates scripts/db-snapshot.sh; until
# then this step always fails loudly, by design.
echo ""
echo "Snapshotting database..."
if [ ! -f "./scripts/db-snapshot.sh" ]; then
  echo "ERROR: scripts/db-snapshot.sh is missing. Refusing to rotate the encryption"
  echo "       key without a database snapshot taken first."
  echo "Restarting BlackVault; nothing was changed."
  $COMPOSE start blackvault
  exit 1
fi
if ! ./scripts/db-snapshot.sh; then
  echo "ERROR: database snapshot failed. See the output above."
  echo "Restarting BlackVault; nothing was changed."
  $COMPOSE start blackvault
  exit 1
fi

# ── 4. Generate the new key ────────────────────────────────────
echo ""
echo "Generating new encryption key..."
NEW_KEY=$(generate_key)
if [ -z "$NEW_KEY" ] || [ "${#NEW_KEY}" -ne 64 ]; then
  echo "ERROR: could not generate a new encryption key (need openssl or /dev/urandom)."
  echo "Restarting BlackVault; nothing was changed."
  $COMPOSE start blackvault
  exit 1
fi
rm -f "$NEW_KEY_FILE"
(
  umask 077
  printf '%s' "$NEW_KEY" > "$NEW_KEY_FILE"
)
NEW_KEY=""

# ── 5. Run the rotation inside the container, in one transaction ──
echo ""
echo "Rotating encryption key (this may take a while on a large inventory)..."
if $COMPOSE run --rm -v "./secrets:/run/rotate:ro" blackvault \
  node scripts/rotate-encryption-key.mjs \
  --old-key-file /run/rotate/blackvault_encryption_key \
  --new-key-file /run/rotate/blackvault_encryption_key.new
then
  # ── 6. Success: swap the key files and restart ──────────────
  mv -f "$KEY_FILE" "$OLD_KEY_FILE"
  mv -f "$NEW_KEY_FILE" "$KEY_FILE"
  $COMPOSE start blackvault
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   Key rotation complete.                                  ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "Back up the new key file now. Delete $OLD_KEY_FILE once you have"
  echo "confirmed everything works."
else
  # ── 7. Failure: clean up and restart on the OLD key ──────────
  echo ""
  echo "ERROR: key rotation failed. See the output above."
  rm -f "$NEW_KEY_FILE"
  echo "Restarting BlackVault on the previous key; nothing was changed."
  $COMPOSE start blackvault
  exit 1
fi
