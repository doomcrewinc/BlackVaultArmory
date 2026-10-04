#!/bin/sh
# snapshot-restore.sh — put an install back from the snapshot that
# scripts/db-snapshot.sh took. The restore side of that script: restore.sh /
# restore.bat run it when a full restore fails (full-backups spec §3 step 5).
#
#   snapshot-restore.sh state   UPLOADS STAMP
#   snapshot-restore.sh markers UPLOADS
#   snapshot-restore.sh uploads UPLOADS STAMP [SNAPSHOT_DIR]
#   snapshot-restore.sh sqlite  SNAPSHOT_DB LIVE_DB [UPLOADS STAMP]
#   snapshot-restore.sh clear-marker UPLOADS STAMP
#
# THE THREE STATES. STAMP is the restore's <ts>. The
# restore program leaves a marker, UPLOADS/.restore-<ts>.db-started, just
# before its database step, and removes it only when everything is in place.
#   started    the marker exists. The database may hold the backup's
#              records, and the folders may be half swapped: roll back.
#   complete   no marker, but UPLOADS/.pre-restore-<ts> holds a previous
#              images/ or documents/ folder. The restore FINISHED. There is
#              nothing to roll back, and rolling the uploads back alone
#              would leave the new records with the old files.
#   untouched  neither. The database step was never reached.
# The rule is enforced HERE, not by the callers: `uploads` moves the previous
# folders back only in state started and changes nothing in state complete,
# so neither wrapper, nor a person following the recovery file, can undo a
# finished restore. `state` prints the word.
#
# Run INSIDE a one-off container of the app image, as root
# (`docker compose run --user 0:0 --entrypoint /bin/sh`), with the host's
# backups/ folder mounted read-only: the snapshot belongs to the host user
# (the database copy) or to the app user, uid 1001 (the uploads copy), and
# the live files belong to uid 1001, so only root can read one and write the
# other. As any other user (the POSIX tests run it on the host) it does the
# same work without the chown. POSIX sh: the image has busybox, not bash.
# The app must be stopped. PostgreSQL's database is put back by the wrapper
# itself, through the db container (psql); this script never sees it.
#
# sqlite   With UPLOADS and STAMP: only in state started; otherwise it says
#          the database was not touched and changes nothing (exit 0).
#          LIVE_DB becomes a byte-for-byte copy of SNAPSHOT_DB. The copy is
#          written beside it, compared with the snapshot, and only then
#          renamed over it; it keeps LIVE_DB's owner and mode. A rollback
#          journal or WAL left by the failed restore is removed (it belongs
#          to the database being replaced); one saved WITH the snapshot
#          (SNAPSHOT_DB-journal / -wal) is put back beside it.
#
# uploads  In state complete: nothing, and it says so (exit 0). Otherwise:
#          1. UPLOADS/.restore-<ts> (its staging folder: copies of the
#             archive's files only) is removed.
#          2. Only in state started. For images and documents: if
#             UPLOADS/.pre-restore-<ts>/<name>
#             exists, the restore had moved the previous folder there. The
#             folder now in its place holds only files from the archive; it
#             is removed and the previous one moved back, exactly as it was
#             (every file, including ones no snapshot holds: *.tmp, *.rot,
#             links). The emptied .pre-restore-<ts> is removed.
#          3. With SNAPSHOT_DIR (backups/uploads-<TS>): every file in the
#             snapshot must now be in UPLOADS with the same bytes. One that
#             is missing or differs is copied back from the snapshot (owner
#             1001, mode 600). A file in UPLOADS that the snapshot does not
#             hold is left alone and reported; nothing else is deleted.
#             Without SNAPSHOT_DIR (db-snapshot.sh found no files to copy)
#             only steps 1 and 2 run.
#          The folders db-snapshot.sh leaves out are left out here too:
#          .pre-encryption-*, .restore-*, .pre-restore-*, *.tmp, *.rot.
#
# markers  prints the stamp of every marker UPLOADS/.restore-<ts>.db-started,
#          one per line; nothing when there is none, or when UPLOADS is not
#          there. Changes nothing.
#
# WHAT COUNTS AS A MARKER, in every mode: anything directly under UPLOADS
# with that name, whatever it is (a folder, which is what the restore program
# creates; a file; a link, dangling or not). The app's start refuses on the
# same rule (assertNoUnfinishedRestore in src/lib/files/startup.ts).
#
# clear-marker  removes UPLOADS/.restore-<ts>.db-started, the marker the
#          restore program leaves just before its database step.
#          The wrapper calls this once its rollback has worked. `uploads`
#          never removes it: while it exists, the database still has to be
#          put back.
#
# Exit status: 0 done and checked; anything else a failure, with one ERROR
# line on standard error. The snapshot is never changed or deleted.
set -eu

APP_UID=1001
APP_GID=1001

fail() {
  echo "ERROR: could not restore from the snapshot: $*" >&2
  exit 1
}

is_root() {
  [ "$(id -u)" = "0" ]
}

# As root, gives $1 to the app user. Never fatal: a network share or a Docker
# Desktop (Windows, macOS) mount refuses or ignores chown, and there the app
# user can use the file anyway.
own() {
  if is_root; then
    chown "$APP_UID:$APP_GID" "$1" 2>/dev/null ||
      echo "WARNING: could not set the owner of $1 to uid $APP_UID (a network share or a Docker Desktop mount refuses this)."
  fi
}

check_stamp() {
  local stamp
  stamp=$1
  case "$stamp" in
    "" | */*) fail "'$stamp' is not a restore stamp." ;;
    *) return 0 ;;
  esac
}

# restore_state UPLOADS STAMP: prints started, complete or untouched (see the top of this file).
restore_state() {
  state_marker="$1/.restore-$2.db-started"
  state_pre="$1/.pre-restore-$2"
  if [ -e "$state_marker" ] || [ -L "$state_marker" ]; then
    echo started
  elif { [ -d "$state_pre/images" ] && [ ! -L "$state_pre/images" ]; } ||
    { [ -d "$state_pre/documents" ] && [ ! -L "$state_pre/documents" ]; }; then
    echo complete
  else
    echo untouched
  fi
}

MODE=${1:-}
case "$MODE" in
  state)
    UP=${2:?usage: snapshot-restore.sh state UPLOADS STAMP}
    STAMP=${3:?usage: snapshot-restore.sh state UPLOADS STAMP}
    check_stamp "$STAMP"
    [ -d "$UP" ] || fail "the uploads folder $UP does not exist."
    restore_state "$UP" "$STAMP"
    exit 0
    ;;
  sqlite)
    SNAP=${2:?usage: snapshot-restore.sh sqlite SNAPSHOT_DB LIVE_DB [UPLOADS STAMP]}
    LIVE=${3:?usage: snapshot-restore.sh sqlite SNAPSHOT_DB LIVE_DB [UPLOADS STAMP]}
    if [ -n "${4:-}" ]; then
      check_stamp "${5:?usage: snapshot-restore.sh sqlite SNAPSHOT_DB LIVE_DB [UPLOADS STAMP]}"
      [ -d "$4" ] || fail "the uploads folder $4 does not exist."
      STATE=$(restore_state "$4" "$5")
      if [ "$STATE" != "started" ]; then
        echo "The restore $5 is in state '$STATE' (its marker $4/.restore-$5.db-started does not exist): the database was not touched by it, and is left as it is."
        exit 0
      fi
    fi
    [ -f "$SNAP" ] || fail "the database snapshot $SNAP does not exist."
    [ -s "$SNAP" ] || fail "the database snapshot $SNAP is empty."
    TMP="$LIVE.rollback.partial"
    rm -f "$TMP"
    # cp -p first: the work file takes the live database's owner and mode.
    if [ -f "$LIVE" ]; then
      cp -p "$LIVE" "$TMP" || fail "could not write beside $LIVE (permissions? free disk space?)."
    else
      (umask 077 && : > "$TMP") || fail "could not write beside $LIVE."
      own "$TMP"
    fi
    cat "$SNAP" > "$TMP" || { rm -f "$TMP"; fail "could not copy $SNAP (free disk space?). The database was not touched."; }
    cmp -s "$SNAP" "$TMP" || { rm -f "$TMP"; fail "the copy of $SNAP does not match it. The database was not touched."; }
    # The failed restore's own journal/WAL must not be replayed onto the snapshot's pages.
    rm -f "$LIVE-journal" "$LIVE-wal" "$LIVE-shm" || fail "could not remove the old journal beside $LIVE."
    mv -f "$TMP" "$LIVE" || fail "could not replace $LIVE. The snapshot copy is at $TMP."
    for ext in -journal -wal; do
      if [ -f "$SNAP$ext" ]; then
        cp -p "$LIVE" "$LIVE$ext" || fail "could not write $LIVE$ext."
        cat "$SNAP$ext" > "$LIVE$ext" || fail "could not copy $SNAP$ext."
      fi
    done
    cmp -s "$SNAP" "$LIVE" || fail "$LIVE does not match the snapshot after the copy."
    echo "Database restored from the snapshot: $SNAP"
    exit 0
    ;;
  uploads) ;;
  markers)
    UP=${2:?usage: snapshot-restore.sh markers UPLOADS}
    for m in "$UP"/.restore-*.db-started; do
      if [ -e "$m" ] || [ -L "$m" ]; then
        m=${m##*/.restore-}
        m=${m%.db-started}
        # A name with nothing between the two parts is not a marker.
        [ -z "$m" ] || echo "$m"
      fi
    done
    exit 0
    ;;
  clear-marker)
    UP=${2:?usage: snapshot-restore.sh clear-marker UPLOADS STAMP}
    STAMP=${3:?usage: snapshot-restore.sh clear-marker UPLOADS STAMP}
    check_stamp "$STAMP"
    rm -rf "${UP:?}/.restore-$STAMP.db-started" || fail "could not remove $UP/.restore-$STAMP.db-started."
    exit 0
    ;;
  --sync)
    # Second stage of `uploads` step 3, run by find below: $2 snapshot, $3
    # uploads, then snapshot files. Prints one line per file it copied back.
    snap=$2
    up=$3
    shift 3
    for f in "$@"; do
      rel=${f#"$snap"}
      dest="$up$rel"
      if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$f" "$dest"; then continue; fi
      dir=$(dirname "$dest")
      if [ ! -d "$dir" ]; then
        (umask 077 && mkdir -p "$dir")
        own "$dir"
      fi
      if [ -e "$dest" ] || [ -L "$dest" ]; then rm -rf "$dest"; fi
      tmp="$dest.rollback.partial"
      rm -f "$tmp"
      : > "$tmp"
      chmod 600 "$tmp"
      cat "$f" > "$tmp"
      own "$tmp"
      mv -f "$tmp" "$dest"
      echo "copied back from the snapshot: ${rel#/}"
    done
    exit 0
    ;;
  *)
    echo "usage: snapshot-restore.sh state UPLOADS STAMP | markers UPLOADS | uploads UPLOADS STAMP [SNAPSHOT_DIR] | sqlite SNAPSHOT_DB LIVE_DB [UPLOADS STAMP] | clear-marker UPLOADS STAMP" >&2
    exit 2
    ;;
esac

UP=${2:?usage: snapshot-restore.sh uploads UPLOADS STAMP [SNAPSHOT_DIR]}
STAMP=${3:?usage: snapshot-restore.sh uploads UPLOADS STAMP [SNAPSHOT_DIR]}
SNAP=${4:-}
check_stamp "$STAMP"
case "$0" in /*) SELF=$0 ;; *) SELF="$(pwd)/$0" ;; esac
[ -d "$UP" ] || fail "the uploads folder $UP does not exist."
if [ -n "$SNAP" ]; then
  [ -d "$SNAP" ] || fail "the uploads snapshot $SNAP does not exist."
  SNAP=$(cd "$SNAP" && pwd -P)
fi
UP=$(cd "$UP" && pwd -P)
STAGING="$UP/.restore-$STAMP"
PRE="$UP/.pre-restore-$STAMP"
STATE=$(restore_state "$UP" "$STAMP")

# A finished restore is never undone. Nothing below runs: not the
# move-back, and not the comparison with the snapshot, which would copy the
# old files over the restored ones.
if [ "$STATE" = "complete" ]; then
  echo "The restore $STAMP had FINISHED (its marker is gone and the previous folders are in $PRE): there is nothing to roll back. Nothing was changed."
  exit 0
fi

# 1. The failed restore's staging folder.
rm -rf "$STAGING" || fail "could not remove $STAGING."

# 2. Folders the restore had already moved aside go back (state started only:
#    restore_state has just said that anything under $PRE belongs to a
#    restore that did not finish).
for name in images documents; do
  if [ "$STATE" = "started" ] && [ -d "$PRE/$name" ] && [ ! -L "$PRE/$name" ]; then
    if [ -e "$UP/$name" ] || [ -L "$UP/$name" ]; then
      rm -rf "${UP:?}/$name" || fail "could not remove the half-restored folder $UP/$name."
    fi
    mv "$PRE/$name" "$UP/$name" || fail "could not move $PRE/$name back to $UP/$name."
    echo "Moved the previous $name folder back into place."
  fi
done
if [ -d "$PRE" ]; then
  rmdir "$PRE" 2>/dev/null || echo "WARNING: $PRE is not empty and was left in place."
fi

if [ -z "$SNAP" ]; then
  echo "Uploads put back (there was no uploads snapshot to compare with: the folder had no files)."
  exit 0
fi

# 3. Everything the snapshot holds must be there, byte for byte.
find "$SNAP" -type f -exec sh "$SELF" --sync "$SNAP" "$UP" {} + || fail "copying files back from $SNAP failed (permissions? free disk space?)."

# Checked independently of the copy above.
BAD=$(find "$SNAP" -type f -exec sh -c '
  snap=$1; up=$2; shift 2
  for f in "$@"; do
    dest="$up${f#"$snap"}"
    if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$f" "$dest"; then :; else echo "$dest"; fi
  done
' sh "$SNAP" "$UP" {} + | head -n 5)
[ -z "$BAD" ] || fail "these files still differ from the snapshot $SNAP: $BAD"

# Reported, never deleted: files the snapshot does not hold.
EXTRA=$(find "$UP" \( -name '.pre-encryption-*' -o -name '.restore-*' -o -name '.pre-restore-*' \) -type d -prune -o \
  -type f ! -name '*.tmp' ! -name '*.rot' -exec sh -c '
    snap=$1; up=$2; shift 2
    for f in "$@"; do
      [ -f "$snap${f#"$up"}" ] || echo "$f"
    done
  ' sh "$SNAP" "$UP" {} + | wc -l | tr -d '[:space:]')
if [ "$EXTRA" -gt 0 ]; then
  echo "WARNING: $EXTRA file(s) in $UP are not in the snapshot $SNAP; they were left in place."
fi
echo "Uploads restored and checked against the snapshot: $SNAP"
exit 0
