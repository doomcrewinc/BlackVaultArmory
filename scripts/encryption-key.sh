# shellcheck shell=bash
#
# Shared by install.sh and update.sh: creates the field-encryption key file
# if it is missing. Source it; do not run it. install.bat and update.bat
# mirror it in :ensure_encryption_key (change them together).
#
# The key: 32 random bytes as 64 lowercase hex characters
# (docs/superpowers/specs/2026-09-30-field-encryption-design.md §1), in
# secrets/blackvault_encryption_key next to docker-compose.yml, mode 600,
# folder mode 700. docker-compose.yml mounts the folder read-only and the
# image's entrypoint hands the key to the app (scripts/docker-entrypoint.sh).
#
# An existing key file is NEVER overwritten or modified: it may be the only
# key the database is encrypted with.
#
# An install may keep its key in BLACKVAULT_ENCRYPTION_KEY
# (in .env, or exported in the shell — Compose passes either to the app)
# instead of the file. Then NO key file is created: a second, different key
# would make the app refuse to start (KEY_CONFLICT). Needs env_value from
# scripts/compose-provider.sh, which every caller sources first.

# Where BLACKVAULT_ENCRYPTION_KEY comes from — "the shell environment" (an
# exported variable overrides .env in Compose) or ".env" — printed on stdout;
# exit 1 (nothing printed) when neither sets a non-empty value.
encryption_key_env_source() {
  if [ -n "${BLACKVAULT_ENCRYPTION_KEY:-}" ]; then
    echo "the shell environment"
    return 0
  fi
  # A line the .env reader cannot read still reaches the app through Compose
  # (substituted or unescaped), so it counts as a key held in .env.
  if env_unreadable BLACKVAULT_ENCRYPTION_KEY || [[ -n "$(env_key_trimmed)" ]]; then
    echo ".env"
    return 0
  fi
  return 1
}

# The BLACKVAULT_ENCRYPTION_KEY value of .env without surrounding whitespace,
# as the app takes it (it trims the variable): a value of spaces is no key.
env_key_trimmed() {
  local value
  value=$(env_value BLACKVAULT_ENCRYPTION_KEY)
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
  return 0
}

ENCRYPTION_KEY_FILE="secrets/blackvault_encryption_key"

# 64 lowercase hex characters from the OS CSPRNG. Never echoed.
generate_encryption_key() {
  if command -v openssl &>/dev/null; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Prints the boxed back-up message for the key file at $1.
print_key_backup_box() {
  echo ""
  echo "=========================================================================="
  echo "  Encryption key created: $1"
  echo ""
  echo "  BACK THIS FILE UP. Without it your serial numbers and NFA records cannot be recovered."
  echo ""
  echo "  Keep a copy somewhere other than this machine (a password manager, a USB"
  echo "  drive). Anyone with this file AND your database can read those records."
  echo "=========================================================================="
  echo ""
}

# Creates $ENCRYPTION_KEY_FILE (relative to the current directory) when it
# does not exist. Returns 0 when the file exists afterwards (created now or
# already there), 1 with a message when it cannot be created.
ensure_encryption_key() {
  local key tmp
  local env_source
  if [ -e "$ENCRYPTION_KEY_FILE" ] || [ -L "$ENCRYPTION_KEY_FILE" ]; then
    echo "Encryption key: $ENCRYPTION_KEY_FILE (existing, unchanged)"
    return 0
  fi
  # Compose passes an exported variable to the app before the .env line, so
  # the .env line only matters when the shell sets none. There it must be a
  # usable key or absent: an unreadable or malformed line is neither "a key
  # is set" nor "no key", and a new key file beside it could be a second key.
  if [[ -z "${BLACKVAULT_ENCRYPTION_KEY:-}" ]]; then
    if env_unreadable BLACKVAULT_ENCRYPTION_KEY; then
      echo "ERROR: $(env_unreadable_text BLACKVAULT_ENCRYPTION_KEY)" >&2
      echo "       This script cannot tell whether an encryption key is already set, so no key file was created." >&2
      return 1
    fi
    key=$(env_key_trimmed)
    if [[ -n "$key" && ! "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
      key=""
      echo "ERROR: BLACKVAULT_ENCRYPTION_KEY in .env is not 64 hex characters, so the app would refuse to start." >&2
      echo "       Correct the line, or remove it to have a key file created. No key file was created." >&2
      return 1
    fi
    key=""
  fi
  if env_source=$(encryption_key_env_source); then
    echo "Encryption key: BLACKVAULT_ENCRYPTION_KEY (from $env_source) - no key file created"
    # docker-compose.yml bind-mounts secrets/ with create_host_path: false,
    # so the (empty) folder must still exist for the container to start.
    { mkdir -p secrets && chmod 700 secrets; } 2>/dev/null || true
    return 0
  fi
  if ! mkdir -p secrets || ! chmod 700 secrets; then
    echo "ERROR: could not create the secrets folder for the encryption key."
    return 1
  fi
  key=$(generate_encryption_key) || key=""
  case "$key" in
    *[!0-9a-f]* | "") key="" ;;
  esac
  if [ "${#key}" -ne 64 ]; then
    echo "ERROR: could not generate an encryption key (need openssl or /dev/urandom)."
    return 1
  fi
  # Written to a temporary name, then hard-linked into place: the link fails
  # if the key file appeared meanwhile (never overwritten), and a failed
  # write never leaves a half-written key behind under the real name.
  tmp="secrets/.blackvault_encryption_key.tmp.$$"
  # chmod BEFORE the key is written: a default ACL on secrets/ overrides
  # the umask (seen on the GitHub runner), so umask alone is not enough.
  if ! (umask 077 && : > "$tmp" && chmod 600 "$tmp" && printf '%s\n' "$key" > "$tmp"); then
    key=""
    rm -f "$tmp"
    echo "ERROR: could not write the encryption key to secrets/."
    return 1
  fi
  key=""
  if ! ln "$tmp" "$ENCRYPTION_KEY_FILE" 2>/dev/null; then
    rm -f "$tmp"
    if [ -e "$ENCRYPTION_KEY_FILE" ]; then
      echo "Encryption key: $ENCRYPTION_KEY_FILE (existing, unchanged)"
      return 0
    fi
    echo "ERROR: could not create $ENCRYPTION_KEY_FILE."
    return 1
  fi
  rm -f "$tmp"
  chmod 600 "$ENCRYPTION_KEY_FILE"
  print_key_backup_box "$PWD/$ENCRYPTION_KEY_FILE"
  return 0
}
