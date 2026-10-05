#!/bin/sh
# BlackVault container entrypoint.
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
    # A symlink would be followed INSIDE the container
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
# a reason to refuse startup. Every step is the condition of an `if` or the
# left side of `||`, so `set -e` never sees a failure here.
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

  # Is anything mounted there? Without a mount the folder is part of the
  # container's own filesystem, and every backup in it goes when the
  # container is recreated (an update does that). docker-compose.yml always
  # mounts it; a plain `docker run` without -v does not.
  #
  # Read from the kernel's mount table, /proc/self/mountinfo, whose fifth
  # field is the mount point: a bind mount, a named volume and a tmpfs are
  # each a line of their own there. Comparing device numbers (`mountpoint`,
  # `stat -c %d`) is not used: a bind mount from the filesystem the
  # container's own files are on has the same device number as its parent.
  # A mount over a parent folder (/app) counts too: what is written under it
  # is kept. The answer is trusted only when the table also lists the root,
  # which every mount table does: an unreadable or unrecognised table, or an
  # awk that is missing or fails, gives no answer, and then nothing is said.
  MOUNTINFO=/proc/self/mountinfo
  mounted=""
  if [ -r "$MOUNTINFO" ]; then
    mounted=$(awk -v dir="$BACKUPS" '
      $5 == "/" { root = 1; next }
      index(dir "/", $5 "/") == 1 { found = 1 }
      END { if (!root) print "unknown"; else if (found) print "yes"; else print "no" }
    ' "$MOUNTINFO" 2>/dev/null) || mounted=""
  fi
  if [ "$mounted" = "no" ]; then
    # shellcheck disable=SC2016 # printed as it is written in docker-compose.yml, not expanded here
    compose_line='- ${BLACKVAULT_BACKUP_DIR:-${DATA_DIR:-./data}/backups}:'"$BACKUPS"
    echo "[entrypoint] WARNING: no folder is mounted at $BACKUPS, so full backups written there are lost when the container is recreated. Mount a folder there: docker-compose.yml does it with the line \"$compose_line\" (set BLACKVAULT_BACKUP_DIR in .env to choose the folder); with docker run, add -v <folder>:$BACKUPS. BlackVault starts anyway." >&2
  fi
fi

# The uploads folder (/app/uploads) and the data folder (/app/data, where the
# SQLite database lives; empty on a PostgreSQL install). docker-compose.yml
# mounts <DATA_DIR>/uploads and <DATA_DIR>/db there. On native Linux a bind
# mount keeps the host owner, and install.sh creates both folders as the user
# who ran it (typically uid 1000), so the app user (uid 1001) could not write
# in them: every upload failed. They are given to the app user here.
#
# Only a folder that does not already belong to nextjs:nodejs is touched, and
# only then is what is inside it given over too (files copied in by hand as
# another user, an older install's files): a normal start never walks a large
# uploads folder. A single foreign file inside a folder that is already right
# is left alone. Modes are never changed. chown -h so a symbolic link inside
# is itself given over and never followed out of the folder.
#
# Nothing here may stop the container from starting. On a share that refuses
# chown (NFS with root squash, SMB, a read-only mount) the app user is tested
# for write access, as for the backup folder above, and one warning is printed
# only when it cannot write.
own_app_folder() {
  folder=$1
  what=$2
  host_folder=$3
  [ -d "$folder" ] || return 0
  if [ "$(stat -c '%U:%G' "$folder" 2>/dev/null)" = "nextjs:nodejs" ]; then
    return 0
  fi
  why=""
  if ! chown -hR nextjs:nodejs "$folder" 2>/dev/null; then
    why=" Its owner could not be changed (a network share usually refuses this)."
  fi
  probe="$folder/.blackvault-write-test.$$"
  if ! su-exec nextjs:nodejs sh -c ': > "$1" && rm -f "$1"' sh "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    echo "[entrypoint] WARNING: the folder $folder is not writable by the app (uid 1001).$why $what will fail until it is. The host folder mounted there is $host_folder (DATA_DIR is set in .env, default ./data); on the host run: sudo chown -R 1001:1001 $host_folder. BlackVault starts anyway." >&2
  fi
}
own_app_folder /app/uploads "Uploading photos and documents" "<DATA_DIR>/uploads"
own_app_folder /app/data "Saving to the SQLite database" "<DATA_DIR>/db"

exec su-exec nextjs:nodejs "$@"
