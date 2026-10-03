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
# file it is given, as before. (That is why backup.sh's one-off container is
# NOT started with --user: it needs this script's root step for the key.) When /run/blackvault-secrets is not mounted
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

# The full-backup folder (full-backups spec, section 2). docker-compose.yml
# mounts BLACKVAULT_BACKUP_DIR (default <DATA_DIR>/backups) here; Docker
# creates a missing host folder owned by root, so it is given to the app user
# (uid 1001), mode 0700, before the drop to that user.
#
# Nothing in this block may stop the container from starting: backups are not
# a reason to refuse startup. Every step is the condition of an `if`, so
# `set -e` never sees a failure here.
#
# On a NAS mount (NFS with root squash, SMB) chown or chmod is refused. That
# is fine as long as the app user can write there anyway, so that is TESTED,
# by creating and removing a file as that user; mode bits are not trusted
# (an ACL, a squashed uid or a read-only mount all make them lie). When it
# cannot write, the Settings button and backup.sh fail with a message that
# names the folder; BlackVault itself runs normally.
#
# chmod 700 runs ONLY after chown succeeded. chmod needs just "the caller
# owns the folder", so it can succeed where chown is refused (root owns the
# mount but may not chown it: capabilities dropped, an NFSv4 id-mapping
# refusal, a share mounted uid=0). 0700 with an owner that is not the app
# user would lock the app out of a folder it could write to through its
# group/other bits, and the change would stay on the share. So after a
# refused chown the mode is left exactly as it is, and the warning says so.
BACKUPS=/app/backups
backups_ok=1
if ! mkdir -p "$BACKUPS" 2>/dev/null; then
  backups_ok=0
  echo "[entrypoint] WARNING: could not create the backup folder $BACKUPS. Full backups will fail until it exists; BlackVault starts anyway." >&2
fi
if [ "$backups_ok" = 1 ]; then
  refused=""
  if chown nextjs:nodejs "$BACKUPS" 2>/dev/null; then
    chmod 700 "$BACKUPS" 2>/dev/null || refused="mode"
  else
    refused="owner"
  fi
  case "$refused" in
    owner) note="could not set the owner of the backup folder $BACKUPS (a network share usually refuses this), so its mode was left as it is." ;;
    mode) note="could not set the mode of the backup folder $BACKUPS (a network share usually refuses this)." ;;
    *) note="" ;;
  esac
  probe="$BACKUPS/.blackvault-write-test.$$"
  if su-exec nextjs:nodejs sh -c ': > "$1" && rm -f "$1"' sh "$probe" 2>/dev/null; then
    if [ -n "$note" ]; then
      echo "[entrypoint] WARNING: $note The app can write to it, so full backups will work; who else can read that folder is decided by the share, not by BlackVault." >&2
    fi
  else
    rm -f "$probe" 2>/dev/null || true
    case "$refused" in
      owner) why="; its owner could not be changed, so its mode was left as it is" ;;
      mode) why="; its mode could not be changed" ;;
      *) why="" ;;
    esac
    echo "[entrypoint] WARNING: the backup folder $BACKUPS is not writable by the app (uid 1001)$why. Full backups will fail until the folder mounted there (BLACKVAULT_BACKUP_DIR, default <DATA_DIR>/backups) is writable by uid 1001. BlackVault starts anyway." >&2
  fi
fi

exec su-exec nextjs:nodejs "$@"
