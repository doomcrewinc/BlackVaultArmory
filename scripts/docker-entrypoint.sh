#!/bin/sh
# BlackVault container entrypoint (field encryption, Task 7, carry I3).
#
# THE PROBLEM. The field-encryption key lives on the host in
# secrets/blackvault_encryption_key, mode 600, owned by whoever ran
# install.sh (typically uid 1000). The app runs as `nextjs` (uid 1001). On
# native Linux Docker a bind mount keeps the host owner and mode, so uid 1001
# cannot read a 600 file owned by uid 1000. Compose `secrets:` do not help:
# without Swarm, a file secret is a plain bind mount and its uid/gid/mode
# options are ignored (docker/compose pkg/compose/create.go,
# buildContainerSecretMounts). Docker Desktop (macOS/Windows) masks this.
#
# THE FIX. The container starts as root only for this script, which:
#   1. copies the key files from the read-only bind mount of the host's
#      secrets/ folder (/run/blackvault-secrets) into /run/secrets — a tmpfs
#      in docker-compose.yml, so the copy never touches disk — owned by
#      nextjs, mode 400;
#   2. drops to nextjs with su-exec and runs the command.
# The app then reads its default key file /run/secrets/blackvault_encryption_key.
# On the host the key stays mode 600 and owned by the user: no chown, no
# sudo, no group widening. The same applies to `docker compose run` (the
# key-rotation wrappers): the entrypoint runs for it too and also copies
# blackvault_encryption_key.new when present.
#
# Copied: ONLY blackvault_encryption_key and blackvault_encryption_key.new.
# Older keys kept in secrets/ (.old-<ts>, .new.unused-<ts>) are never copied.
#
# When the container is started as a non-root user (`--user`, compose
# `user:`), nothing is copied: the command runs as-is and reads whatever key
# file it is given, as before. When /run/blackvault-secrets is not mounted
# (plain `docker run`, a Swarm secret at /run/secrets/...), nothing is copied
# either and /run/secrets is left alone.
set -eu

SRC=/run/blackvault-secrets
DST=/run/secrets

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

if [ -d "$SRC" ]; then
  mkdir -p "$DST"
  # A previous start of this container may have left copies (when /run/secrets
  # is not a tmpfs); a key removed on the host must not survive here.
  rm -f "$DST/blackvault_encryption_key" "$DST/blackvault_encryption_key.new"
  chown nextjs:nodejs "$DST"
  chmod 700 "$DST"
  for name in blackvault_encryption_key blackvault_encryption_key.new; do
    # Fix round 1 (M9): a symlink would be followed INSIDE the container
    # (e.g. to /etc/shadow) and its target copied where nextjs can read it.
    if [ -L "$SRC/$name" ]; then
      echo "[entrypoint] Refusing to start: secrets/$name is a symbolic link. Replace it with the key file itself." >&2
      exit 1
    fi
    [ -f "$SRC/$name" ] || continue
    if ! (umask 077 && cat "$SRC/$name" > "$DST/$name"); then
      echo "[entrypoint] Cannot read the key file $name from the secrets folder (mounted at $SRC). Refusing to start." >&2
      rm -f "$DST/$name"
      exit 1
    fi
    chown nextjs:nodejs "$DST/$name"
    chmod 400 "$DST/$name"
  done
fi

exec su-exec nextjs:nodejs "$@"
