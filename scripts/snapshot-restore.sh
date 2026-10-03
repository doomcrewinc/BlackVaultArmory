#!/bin/sh
# snapshot-restore.sh — put an install back from the snapshot that
# scripts/db-snapshot.sh took. The restore side of that script: restore.sh /
# restore.bat run it when a full restore fails (full-backups spec §3 step 5).
#
#   snapshot-restore.sh sqlite  SNAPSHOT_DB LIVE_DB
#   snapshot-restore.sh uploads UPLOADS STAMP [SNAPSHOT_DIR]
#   snapshot-restore.sh clear-marker UPLOADS STAMP
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
# sqlite   LIVE_DB becomes a byte-for-byte copy of SNAPSHOT_DB. The copy is
#          written beside it, compared with the snapshot, and only then
#          renamed over it; it keeps LIVE_DB's owner and mode. A rollback
#          journal or WAL left by the failed restore is removed (it belongs
#          to the database being replaced); one saved WITH the snapshot
#          (SNAPSHOT_DB-journal / -wal) is put back beside it.
#
# uploads  STAMP is the failed restore's <ts>. In order:
#          1. UPLOADS/.restore-<ts> (its staging folder: copies of the
#             archive's files only) is removed.
#          2. For images and documents: if UPLOADS/.pre-restore-<ts>/<name>
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
# clear-marker  removes UPLOADS/.restore-<ts>.db-started, the marker the
#          restore program leaves just before its database step (ruling R24).
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

MODE=${1:-}
case "$MODE" in
  sqlite)
    SNAP=${2:?usage: snapshot-restore.sh sqlite SNAPSHOT_DB LIVE_DB}
    LIVE=${3:?usage: snapshot-restore.sh sqlite SNAPSHOT_DB LIVE_DB}
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
  clear-marker)
    UP=${2:?usage: snapshot-restore.sh clear-marker UPLOADS STAMP}
    STAMP=${3:?usage: snapshot-restore.sh clear-marker UPLOADS STAMP}
    case "$STAMP" in
      "" | */* | .*) fail "'$STAMP' is not a restore stamp." ;;
    esac
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
    echo "usage: snapshot-restore.sh sqlite SNAPSHOT_DB LIVE_DB | uploads UPLOADS STAMP [SNAPSHOT_DIR] | clear-marker UPLOADS STAMP" >&2
    exit 2
    ;;
esac

UP=${2:?usage: snapshot-restore.sh uploads UPLOADS STAMP [SNAPSHOT_DIR]}
STAMP=${3:?usage: snapshot-restore.sh uploads UPLOADS STAMP [SNAPSHOT_DIR]}
SNAP=${4:-}
case "$STAMP" in
  "" | */* | .*) fail "'$STAMP' is not a restore stamp." ;;
esac
case "$0" in /*) SELF=$0 ;; *) SELF="$(pwd)/$0" ;; esac
[ -d "$UP" ] || fail "the uploads folder $UP does not exist."
if [ -n "$SNAP" ]; then
  [ -d "$SNAP" ] || fail "the uploads snapshot $SNAP does not exist."
  SNAP=$(cd "$SNAP" && pwd -P)
fi
UP=$(cd "$UP" && pwd -P)
STAGING="$UP/.restore-$STAMP"
PRE="$UP/.pre-restore-$STAMP"

# 1. The failed restore's staging folder.
rm -rf "$STAGING" || fail "could not remove $STAGING."

# 2. Folders the restore had already moved aside go back.
for name in images documents; do
  if [ -d "$PRE/$name" ] && [ ! -L "$PRE/$name" ]; then
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
