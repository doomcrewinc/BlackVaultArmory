#!/bin/sh
# uploads-snapshot.sh SRC BACKUPS NAME — copy the uploads folder SRC into
# BACKUPS/NAME. Run by scripts/db-snapshot.sh INSIDE a one-off container of
# the app image (`docker compose run --user 0:0`), with the host's backups/
# folder mounted at BACKUPS: the uploaded files are BVF1 files mode 600 owned
# by the app user (uid 1001), which the host user cannot read on Linux.
# POSIX sh: the image has busybox, not bash.
#
# As root it creates BACKUPS/NAME.partial (owner 1001, mode 700) and does the
# copy as 1001 with su-exec, so everything in the snapshot belongs to the app
# user; it then renames the folder to NAME. As any other user (the POSIX
# tests run it on the host) it does the copy itself.
#
# Copied: regular files only. Never followed or copied: symbolic links
# (reported). Skipped: the app's own .pre-encryption-* snapshot folders and
# every *.tmp / *.rot file (half-written or mid-rotation files). Every folder
# is mode 700 and every file is created empty and chmod 600 BEFORE its bytes
# are written (a default ACL on the parent can override the umask).
#
# Exit status: 0 a snapshot was written; 3 nothing to snapshot (no folder or
# no files to copy), nothing written; anything else a failure, with an
# ERROR line, and the .partial folder removed.
set -eu

APP_UID=1001
APP_GID=1001

if [ "${1:-}" = "--copy" ]; then
  # Second stage: the copy itself, into the CURRENT folder (the .partial
  # folder). As uid 1001 it could not traverse the host's backups/ (mode 700,
  # owned by the host user) by path, but the working directory su-exec
  # inherits needs no path. Both finds use -exec ... +, so a folder find
  # cannot read or a failed copy makes find, and so this stage, exit non-zero.
  SRC=$2
  umask 077
  find "$SRC" -name '.pre-encryption-*' -type d -prune -o -type d -exec sh -c '
    set -e
    src=$1; shift
    for d in "$@"; do
      rel=${d#"$src"}
      [ -z "$rel" ] && continue
      mkdir -p ".$rel"
      chmod 700 ".$rel"
    done
  ' sh "$SRC" {} +
  find "$SRC" -name '.pre-encryption-*' -type d -prune -o \
    -type f ! -name '*.tmp' ! -name '*.rot' -exec sh -c '
      set -e
      src=$1; shift
      for f in "$@"; do
        out=".${f#"$src"}"
        : > "$out"
        chmod 600 "$out"
        cat "$f" > "$out"
      done
    ' sh "$SRC" {} +
  # Belt and braces: whatever find does with a failed -exec, the copy must
  # hold exactly as many files as the source.
  want=$(find "$SRC" -name '.pre-encryption-*' -type d -prune -o -type f ! -name '*.tmp' ! -name '*.rot' -print | wc -l)
  got=$(find . -type f | wc -l)
  [ "$want" -eq "$got" ] || { echo "copied $got of $want files" >&2; exit 1; }
  exit 0
fi

SRC=${1:?usage: uploads-snapshot.sh SRC BACKUPS NAME}
BACKUPS=${2:?usage: uploads-snapshot.sh SRC BACKUPS NAME}
NAME=${3:?usage: uploads-snapshot.sh SRC BACKUPS NAME}
PARTIAL="$BACKUPS/$NAME.partial"
case "$0" in /*) SELF=$0 ;; *) SELF="$(pwd)/$0" ;; esac
case "$SRC" in /*) ;; *) SRC="$(pwd)/$SRC" ;; esac
FINAL="$BACKUPS/$NAME"

# A .partial left by an interrupted earlier run is never a snapshot.
rm -rf "$BACKUPS"/uploads-*.partial

[ -d "$SRC" ] || exit 3
find "$SRC" -name '.pre-encryption-*' -type d -prune -o -type l -print | while IFS= read -r l; do
  echo "WARNING: skipped the symbolic link $l while snapshotting uploads; it was not copied."
done
FIRST=$(find "$SRC" -name '.pre-encryption-*' -type d -prune -o -type f ! -name '*.tmp' ! -name '*.rot' -print | head -n 1)
[ -n "$FIRST" ] || exit 3

failed() {
  rm -rf "$PARTIAL"
  echo "ERROR: could not snapshot the uploads folder: $* (permissions? free disk space?). Nothing was kept."
  exit 1
}

[ -e "$FINAL" ] && failed "$FINAL already exists"
(umask 077 && mkdir "$PARTIAL") || failed "could not create $PARTIAL"
chmod 700 "$PARTIAL" || failed "could not restrict $PARTIAL"
if [ "$(id -u)" = "0" ]; then
  chown "$APP_UID:$APP_GID" "$PARTIAL" || failed "could not give $PARTIAL to uid $APP_UID"
  (cd "$PARTIAL" && su-exec "$APP_UID:$APP_GID" sh "$SELF" --copy "$SRC") || failed "copying $SRC failed"
else
  (cd "$PARTIAL" && sh "$SELF" --copy "$SRC") || failed "copying $SRC failed"
fi
mv "$PARTIAL" "$FINAL" || failed "could not rename $PARTIAL to $FINAL"
chmod 700 "$FINAL"
echo "Uploads snapshot written: $NAME"
exit 0
