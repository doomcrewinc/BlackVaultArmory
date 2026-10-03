#!/bin/bash
# full-backup-entrypoint-linux.sh IMAGE — the image's entrypoint and a backup
# folder whose owner and mode cannot be changed (full backups, Task 6, Review
# Focus 1: a NAS mount). Real Linux Docker; nothing is stubbed.
#
# A network share is imitated by dropping CAP_CHOWN and CAP_FOWNER from the
# container: root's chown of /app/backups is then refused (EPERM). The folder
# is a tmpfs owned by root, so nothing touches the host — and because root
# OWNS it, a chmod would still succeed (chmod needs ownership, not a
# capability). That is the case fix round 1 is about: after a refused chown
# the entrypoint must NOT chmod the folder to 0700, or uid 1001 loses the
# write access it had through the other bits.
#   mode 1777  → chown refused, uid 1001 can write: a WARNING, the mode is
#                STILL 1777, the command runs, and uid 1001 really can create
#                a file there.
#   mode 0755  → chown refused and NOT writable: a WARNING naming the folder,
#                the mode is still 755, and the command STILL runs (backups
#                are no reason not to start).
# No secrets mount: without CAP_CHOWN the key copy would (rightly) refuse to
# start, and that path has its own job (scripts/ci/encryption-key-linux.sh).
#
# In both NAS cases the REAL backup program then runs in that container
# (Task 9), against a scratch SQLite database it migrates itself and a
# throw-away key given in the environment:
#   writable      → exit 0, the BLACKVAULT_FULL_BACKUP_OK line, and the .bvb
#                   is in the folder, mode 600, owned by uid 1001.
#   not writable  → exit 1 and one `full-backup:` line that names the folder
#                   and BLACKVAULT_BACKUP_DIR; nothing is written.
# The passphrase and the key here are test values made up on the spot; a real
# passphrase never goes on a command line (backup.sh sends it on stdin).
#
# Every docker call is bounded by `timeout`. Containers are named
# bvbk-t6-ep-* and removed on exit.
set -uo pipefail

IMAGE=${1:?usage: full-backup-entrypoint-linux.sh IMAGE}
FAILED=0
cleanup() {
  for c in bvbk-t6-ep-writable bvbk-t6-ep-readonly bvbk-t6-ep-normal bvbk-t6-ep-id; do
    timeout 60 docker rm -f "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
cleanup

check() { # check DESCRIPTION CONDITION-STATUS
  if [ "$2" -eq 0 ]; then echo "    ok   $1"; else echo "    FAIL $1"; FAILED=1; fi
}
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# What runs inside the container, as the command the entrypoint hands over to.
# The write probe is `touch`, not `: > file`: a failed redirection on the
# special builtin `:` makes busybox sh EXIT (POSIX), and the first version of
# this script reported the not-writable case as "the command did not run".
# shellcheck disable=SC2016 # expanded by the container's shell, not here
PROBE='echo "RAN-AS=$(id -u)"
if touch /app/backups/.t6-probe 2>/dev/null; then echo WRITE=yes; rm -f /app/backups/.t6-probe; else echo WRITE=no; fi
stat -c "STAT=%u:%g %a" /app/backups
if [ "${T9_BACKUP:-}" = 1 ]; then
  mkdir -p /tmp/t9 &&
    node node_modules/prisma/build/index.js migrate deploy --schema prisma/sqlite/schema.prisma >/tmp/t9/migrate.log 2>&1 ||
    { echo "MIGRATE=failed"; cat /tmp/t9/migrate.log; }
  printf "%s" "nas case passphrase 0123" | node dist/scripts/full-backup.mjs
  echo "BACKUP-RC=$?"
  for f in /app/backups/*.bvb; do [ -f "$f" ] && stat -c "BVB=%u:%g %a" "$f"; done
  echo "LEFT=[$(ls -A /app/backups | tr "\n" " ")]"
fi'

# run NAME TMPFS-MODE [extra docker args...] → OUT (stdout+stderr), RC
run_case() {
  local name=$1 mode=$2
  shift 2
  OUT=$(timeout 180 docker run --name "$name" "$@" \
    -e DB_PROVIDER=sqlite -e "DATABASE_URL=file:/tmp/t9/vault.db?connection_limit=1" \
    -e "BLACKVAULT_ENCRYPTION_KEY=$TEST_KEY" \
    --tmpfs "/app/backups:rw,mode=$mode" "$IMAGE" \
    sh -c "$PROBE" 2>&1)
  RC=$?
  echo "$OUT" | sed 's/^/       | /'
}
TEST_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

# `exec -u nextjs` (the admin commands in the README) takes the user's primary
# group from the image's /etc/passwd: it must be the group the app runs with.
echo "==> the image's app user"
ID_OUT=$(timeout 60 docker run --rm --name bvbk-t6-ep-id --entrypoint id "$IMAGE" nextjs 2>&1)
check "nextjs is uid 1001 with primary group nodejs, gid 1001 (id nextjs: $ID_OUT)" "$(has "$ID_OUT" "uid=1001(nextjs) gid=1001(nodejs)"; echo $?)"

echo "==> chown refused, folder writable by uid 1001"
run_case bvbk-t6-ep-writable 1777 --cap-drop CHOWN --cap-drop FOWNER -e T9_BACKUP=1
check "the command ran (exit 0, got $RC)" "$([ "$RC" -eq 0 ]; echo $?)"
check "as uid 1001" "$(has "$OUT" "RAN-AS=1001"; echo $?)"
check "warns that the owner could not be set and the mode was left alone" "$(has "$OUT" "[entrypoint] WARNING: could not set the owner of the backup folder /app/backups (a network share usually refuses this), so its mode was left as it is."; echo $?)"
check "says backups will work" "$(has "$OUT" "full backups will work"; echo $?)"
check "uid 1001 really can write there" "$(has "$OUT" "WRITE=yes"; echo $?)"
check "the folder is still root's and still mode 1777 (chown refused, no chmod 700)" "$(has "$OUT" "STAT=0:0 1777"; echo $?)"
check "a real backup there succeeds (exit 0)" "$(has "$OUT" "BACKUP-RC=0"; echo $?)"
check "and prints its OK line" "$(has "$OUT" "BLACKVAULT_FULL_BACKUP_OK file=blackvault-full-"; echo $?)"
check "the .bvb is in the folder, mode 600, owned by uid 1001" "$(has "$OUT" "BVB=1001:1001 600"; echo $?)"
check "no .partial and no lock are left" "$(has "$OUT" ".partial" || has "$OUT" ".full-backup.lock" || ! has "$OUT" "LEFT=[blackvault-full-"; [ $? -ne 0 ]; echo $?)"

echo "==> chown refused, folder NOT writable by uid 1001"
run_case bvbk-t6-ep-readonly 0755 --cap-drop CHOWN --cap-drop FOWNER -e T9_BACKUP=1
check "the command STILL ran (exit 0, got $RC)" "$([ "$RC" -eq 0 ]; echo $?)"
check "as uid 1001" "$(has "$OUT" "RAN-AS=1001"; echo $?)"
check "warns that the folder is not writable, naming it" "$(has "$OUT" "[entrypoint] WARNING: the backup folder /app/backups is not writable by the app (uid 1001)"; echo $?)"
check "names BLACKVAULT_BACKUP_DIR" "$(has "$OUT" "BLACKVAULT_BACKUP_DIR"; echo $?)"
check "uid 1001 really cannot write there" "$(has "$OUT" "WRITE=no"; echo $?)"
check "the folder is still root's and still mode 755" "$(has "$OUT" "STAT=0:0 755"; echo $?)"
check "a real backup there fails (exit 1)" "$(has "$OUT" "BACKUP-RC=1"; echo $?)"
check "with one line that names the folder" "$(has "$OUT" "full-backup: The backup folder /app/backups is not writable (EACCES)."; echo $?)"
check "and says which setting mounts it" "$(has "$OUT" "the folder mounted from BLACKVAULT_BACKUP_DIR"; echo $?)"
check "nothing was written there" "$(has "$OUT" "LEFT=[]"; echo $?)"

echo "==> normal folder (all capabilities)"
run_case bvbk-t6-ep-normal 0755
check "the command ran (exit 0, got $RC)" "$([ "$RC" -eq 0 ]; echo $?)"
check "no warning" "$(has "$OUT" "WARNING" && echo 1 || echo 0)"
check "the folder is 1001:1001 mode 700" "$(has "$OUT" "STAT=1001:1001 700"; echo $?)"
check "uid 1001 can write there" "$(has "$OUT" "WRITE=yes"; echo $?)"

if [ "$FAILED" -ne 0 ]; then
  echo "full-backup entrypoint checks FAILED"
  exit 1
fi
echo "full-backup entrypoint checks passed"
