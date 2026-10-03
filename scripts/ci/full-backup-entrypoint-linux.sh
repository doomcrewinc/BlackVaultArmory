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
# Every docker call is bounded by `timeout`. Containers are named
# bvbk-t6-ep-* and removed on exit.
set -uo pipefail

IMAGE=${1:?usage: full-backup-entrypoint-linux.sh IMAGE}
FAILED=0
cleanup() {
  for c in bvbk-t6-ep-writable bvbk-t6-ep-readonly bvbk-t6-ep-normal; do
    timeout 60 docker rm -f "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
cleanup

check() { # check DESCRIPTION CONDITION-STATUS
  if [ "$2" -eq 0 ]; then echo "    ok   $1"; else echo "    FAIL $1"; FAILED=1; fi
}
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# run NAME TMPFS-MODE [extra docker args...] → OUT (stdout+stderr), RC
run_case() {
  local name=$1 mode=$2
  shift 2
  OUT=$(timeout 120 docker run --name "$name" "$@" \
    --tmpfs "/app/backups:rw,mode=$mode" "$IMAGE" \
    sh -c 'echo "RAN-AS=$(id -u)"; if : > /app/backups/.t6-probe 2>/dev/null; then echo WRITE=yes; rm -f /app/backups/.t6-probe; else echo WRITE=no; fi; stat -c "STAT=%u:%g %a" /app/backups' 2>&1)
  RC=$?
  echo "$OUT" | sed 's/^/       | /'
}

echo "==> chown refused, folder writable by uid 1001"
run_case bvbk-t6-ep-writable 1777 --cap-drop CHOWN --cap-drop FOWNER
check "the command ran (exit 0, got $RC)" "$([ "$RC" -eq 0 ]; echo $?)"
check "as uid 1001" "$(has "$OUT" "RAN-AS=1001"; echo $?)"
check "warns that the owner could not be set and the mode was left alone" "$(has "$OUT" "[entrypoint] WARNING: could not set the owner of the backup folder /app/backups (a network share usually refuses this), so its mode was left as it is."; echo $?)"
check "says backups will work" "$(has "$OUT" "full backups will work"; echo $?)"
check "uid 1001 really can write there" "$(has "$OUT" "WRITE=yes"; echo $?)"
check "the folder is still root's and still mode 1777 (chown refused, no chmod 700)" "$(has "$OUT" "STAT=0:0 1777"; echo $?)"

echo "==> chown refused, folder NOT writable by uid 1001"
run_case bvbk-t6-ep-readonly 0755 --cap-drop CHOWN --cap-drop FOWNER
check "the command STILL ran (exit 0, got $RC)" "$([ "$RC" -eq 0 ]; echo $?)"
check "as uid 1001" "$(has "$OUT" "RAN-AS=1001"; echo $?)"
check "warns that the folder is not writable, naming it" "$(has "$OUT" "[entrypoint] WARNING: the backup folder /app/backups is not writable by the app (uid 1001)"; echo $?)"
check "names BLACKVAULT_BACKUP_DIR" "$(has "$OUT" "BLACKVAULT_BACKUP_DIR"; echo $?)"
check "uid 1001 really cannot write there" "$(has "$OUT" "WRITE=no"; echo $?)"
check "the folder is still root's and still mode 755" "$(has "$OUT" "STAT=0:0 755"; echo $?)"

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
