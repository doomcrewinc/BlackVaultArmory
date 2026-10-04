# shellcheck shell=bash
#
# Shared by backup.sh, restore.sh and reencrypt-files.sh (full-backups spec
# §2 and §3); update.sh and rotate-key.sh use its restore-marker check.
# Source it; do not run it. It must be sourced AFTER scripts/compose-provider.sh
# (it uses env_value and compose_version_ok) and from the folder that holds
# docker-compose.yml. backup.bat and restore.bat mirror it.
#
# THE PASSPHRASE. Held only in the shell variables PASSPHRASE / FIRST /
# answer below, never exported, and only ever handled by shell builtins
# (read, [, printf): it is never put on a command line or into the
# environment of any program. scripts/full-backup-wrapper.test.ts pins every
# line that names one of those variables, in this file and in both scripts.

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# bv_check_secret_file WHAT CODE: PASSFILE (not empty) and ORIG_PWD are set by
# the caller. Makes PASSFILE absolute and checks that it is a readable file
# that is not empty; otherwise one ERROR line naming it as WHAT, and exit
# CODE. The file is only tested here, never read. reencrypt-files.sh uses it
# for the old key file (which it hands over exactly as a passphrase file is).
bv_check_secret_file() {
  case "$PASSFILE" in /*) ;; *) PASSFILE="$ORIG_PWD/$PASSFILE" ;; esac
  if [ ! -f "$PASSFILE" ] || [ ! -r "$PASSFILE" ]; then
    printf 'ERROR: %s\n' "cannot read the $1 $PASSFILE." >&2
    exit "$2"
  fi
  if [ ! -s "$PASSFILE" ]; then
    printf 'ERROR: %s\n' "the $1 $PASSFILE is empty." >&2
    exit "$2"
  fi
}

# bv_check_passphrase_source: PASSFILE (may be empty) and ORIG_PWD are set by
# the caller. Makes PASSFILE absolute and checks it; with no file and no
# terminal (cron) stops at once instead of waiting on a prompt.
bv_check_passphrase_source() {
  if [ -n "$PASSFILE" ]; then
    bv_check_secret_file "passphrase file" 1
  elif [ ! -t 0 ]; then
    # Under cron there is nothing to prompt on. Stop now; never wait.
    die "no passphrase: standard input is not a terminal, so there is nobody to ask. Use --passphrase-file <path>. Nothing was done."
  fi
}

# bv_compose_setup: sets COMPOSE (or stops), clears the BLACKVAULT_* keys
# docker compose must read from .env only, and sets HOST_BACKUP_DIR and
# HOST_DATA_DIR (the DATA_DIR of .env, default ./data).
bv_compose_setup() {
  local version
  version=$(docker compose version --short 2>/dev/null) || version=""
  compose_version_ok "$version" ||
    die "BlackVault needs Docker Compose v$COMPOSE_MIN_VERSION or newer, run as 'docker compose' (found: ${version:-none}). Nothing was done."
  COMPOSE="docker compose"

  # docker compose must read the BLACKVAULT_* keys from .env only, never from
  # this shell (a shell variable would override .env), and the one-off
  # container must not inherit an uploads-snapshot marker (see rotate-key.sh).
  unset BLACKVAULT_DATABASE_URL BLACKVAULT_DB_PROVIDER BLACKVAULT_POSTGRES_PASSWORD BLACKVAULT_BACKUP_DIR BLACKVAULT_UPLOADS_SNAPSHOT

  # A line the .env reader cannot read is not a missing one: no default
  # folder and no default provider is used in its place.
  local key
  for key in DATA_DIR BLACKVAULT_BACKUP_DIR BLACKVAULT_DB_PROVIDER; do
    if env_unreadable "$key"; then
      die "$(env_unreadable_text "$key") Nothing was done."
    fi
  done

  # NOT named DATA_DIR: if the user's shell exports DATA_DIR, assigning it
  # here would change the value docker compose interpolates into every mount.
  HOST_DATA_DIR=$(env_value DATA_DIR)
  HOST_DATA_DIR="${HOST_DATA_DIR:-./data}"
  # The backup folder on the HOST: the same expression docker-compose.yml
  # mounts at /app/backups. A relative path is relative to this folder.
  HOST_BACKUP_DIR=$(env_value BLACKVAULT_BACKUP_DIR)
  if [ -z "$HOST_BACKUP_DIR" ]; then
    HOST_BACKUP_DIR="$HOST_DATA_DIR/backups"
  fi
}

# One argument, quoted for a POSIX shell only when it needs it: for printing
# a command the user can paste (a checkout path may hold spaces).
bv_shell_quote() {
  case "$1" in
    "" | *[!A-Za-z0-9_./:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}
# bv_quote_cmd ARG...: the whole command on one line, each argument quoted as needed.
bv_quote_cmd() {
  local arg out=""
  for arg in "$@"; do out="$out${out:+ }$(bv_shell_quote "$arg")"; done
  printf '%s\n' "$out"
}

# ── Markers left by a restore ─────────────────────────────────
# WHAT COUNTS AS A MARKER, in every script: anything directly under the
# uploads folder named .restore-<stamp>.db-started, whatever it is (a folder,
# which is what the restore program creates; a file; a link, dangling or not)
# and whatever <stamp> is, as long as it is not empty.
# scripts/snapshot-restore.sh and the app's own start
# (src/lib/backup/restore-marker.ts) go by the same rule.

host_can_enter() {
  local dir=$1
  if [[ -d "$dir" && -r "$dir" && -x "$dir" ]]; then
    return 0
  fi
  return 1
}

# bv_snapshot_restore_cmd: sets SNAPSHOT_RESTORE to the command that runs
# scripts/snapshot-restore.sh as root in a one-off container, backups/ mounted
# read-only. The script is mounted from this checkout, like
# scripts/uploads-snapshot.sh in db-snapshot.sh. Needs COMPOSE.
SNAPSHOT_RESTORE=()
bv_snapshot_restore_cmd() {
  # shellcheck disable=SC2206 # COMPOSE is "docker compose": two words on purpose
  SNAPSHOT_RESTORE=($COMPOSE run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh
    -v "$PWD/backups:/bv-backups:ro"
    -v "$PWD/scripts/snapshot-restore.sh:/bv-snapshot-restore.sh:ro"
    blackvault /bv-snapshot-restore.sh)
  return 0
}

# bv_collect_restore_markers UPLOADS_DIR: fills OLD_STAMPS with the stamp of
# every marker in that folder and sets OLD_WHERE to how their paths are shown.
# From the host when it can enter the folder; otherwise (the folder is closed
# to this user, or is not where .env says because it is mounted from somewhere
# else) from inside a container, as root. Returns 1 when neither could say:
# that is never taken for "no marker", and MARKERS_ERROR then holds what
# Docker wrote to standard error. The stamps are read one line at a time and
# never word-split or expanded. Needs SNAPSHOT_RESTORE.
OLD_STAMPS=()
OLD_WHERE=""
MARKERS_ERROR=""
bv_collect_restore_markers() {
  local dir=$1 m listed errors rc
  OLD_STAMPS=()
  MARKERS_ERROR=""
  if host_can_enter "$dir"; then
    OLD_WHERE="$dir/"
    for m in "$dir"/.restore-*.db-started; do
      if [[ -e "$m" || -L "$m" ]]; then
        m=${m##*/.restore-}
        m=${m%.db-started}
        [[ -z "$m" ]] || OLD_STAMPS+=("$m")
      fi
    done
    return 0
  fi
  OLD_WHERE="/app/uploads/"
  # The container mounts backups/; if Docker had to create that folder it
  # would belong to root, and the snapshot could not be written into it.
  mkdir -p backups 2> /dev/null
  if errors=$(mktemp 2> /dev/null); then
    listed=$("${SNAPSHOT_RESTORE[@]}" markers /app/uploads 2> "$errors")
    rc=$?
    MARKERS_ERROR=$(cat "$errors" 2> /dev/null)
    rm -f "$errors"
  else
    listed=$("${SNAPSHOT_RESTORE[@]}" markers /app/uploads 2> /dev/null)
    rc=$?
  fi
  [[ "$rc" -eq 0 ]] || return 1
  while IFS= read -r m; do
    [[ -z "$m" ]] || OLD_STAMPS+=("$m")
  done <<< "$listed"
  return 0
}

# bv_describe_restore_markers: from OLD_STAMPS (not empty) and OLD_WHERE, sets
# OLD_MARKERS to every marker's path and OLD_COMMANDS to ONE command line
# that removes them all.
bv_describe_restore_markers() {
  local stamp
  OLD_MARKERS=""
  OLD_COMMANDS=""
  for stamp in "${OLD_STAMPS[@]}"; do
    OLD_MARKERS="${OLD_MARKERS:+$OLD_MARKERS, }$OLD_WHERE.restore-$stamp.db-started"
    OLD_COMMANDS="${OLD_COMMANDS:+$OLD_COMMANDS && }$(bv_quote_cmd "${SNAPSHOT_RESTORE[@]}" clear-marker /app/uploads "$stamp")"
  done
  [[ "$OLD_WHERE" != "/app/uploads/" ]] || OLD_MARKERS="$OLD_MARKERS (inside the container)"
  return 0
}

# bv_restore_marker_refusal UPLOADS_DIR: for a script that is about to stop,
# rebuild or re-key a running BlackVault (update.sh, rotate-key.sh). Returns 1
# after an ERROR (on standard error) that names every marker and the one
# command line that removes them; the caller adds what was not done. Returns 0 when there is no
# marker, when the folder does not exist yet, and, after a Note, when neither
# the host nor a container could look. Needs COMPOSE.
bv_restore_marker_refusal() {
  local dir=$1
  if [[ ! -e "$dir" ]]; then
    return 0
  fi
  bv_snapshot_restore_cmd
  if ! bv_collect_restore_markers "$dir"; then
    [[ -z "$MARKERS_ERROR" ]] || printf '%s\n' "$MARKERS_ERROR"
    echo "Note: could not check the uploads folder $dir for a marker left by a restore: it cannot be looked into from here, and asking inside a container failed. Going on without that check."
    return 0
  fi
  if [[ "${#OLD_STAMPS[@]}" -eq 0 ]]; then
    return 0
  fi
  bv_describe_restore_markers
  {
    echo "ERROR: the uploads folder holds a marker left by a restore: $OLD_MARKERS."
    echo "       This version of BlackVault refuses to start while a marker exists: the"
    echo "       restore that left it may not have finished. If backups/ holds a"
    echo "       restore-<time>-RECOVERY.txt file, follow it. If BlackVault is running"
    echo "       and its records, photos and documents are what you expect, remove"
    echo "       every marker with:"
    echo "         $OLD_COMMANDS"
  } >&2
  return 1
}

# Physical absolute path of a folder. The backup folder is mode 0700 and
# owned by the app user (uid 1001), so on Linux the host user usually cannot
# enter it: then its PARENT is resolved and the last component appended.
canonical_dir() {
  local dir=$1 parent base
  if (cd "$dir" 2>/dev/null); then
    (cd "$dir" && pwd -P)
    return
  fi
  while [ "${dir%/}" != "$dir" ] && [ -n "${dir%/}" ]; do dir=${dir%/}; done
  parent=$(dirname "$dir")
  base=$(basename "$dir")
  case "$base" in . | .. | /) return 1 ;; esac
  parent=$(cd "$parent" 2>/dev/null && pwd -P) || return 1
  [ "$parent" = "/" ] && parent=""
  printf '%s/%s\n' "$parent" "$base"
}

# bv_backup_file_name LABEL FILE: FILE is a name in the backup folder, or a
# host path to a file in it. Sets BACKUP_FILE_NAME to the name the program
# inside the container looks up in /app/backups; a path outside the backup
# folder, or something that is not a file name, stops with an error.
bv_backup_file_name() {
  local label=$1 file=$2 file_path file_dir backup_dir_real
  case "$file" in
    */*)
      case "$file" in /*) file_path=$file ;; *) file_path="$ORIG_PWD/$file" ;; esac
      BACKUP_FILE_NAME=$(basename "$file_path")
      file_dir=$(canonical_dir "$(dirname "$file_path")") || file_dir=""
      backup_dir_real=$(canonical_dir "$HOST_BACKUP_DIR") || backup_dir_real=""
      { [ -n "$file_dir" ] && [ "$file_dir" = "$backup_dir_real" ]; } ||
        die "$label: $file is not in the backup folder ($HOST_BACKUP_DIR). Give a file name, or the path of a file in that folder."
      ;;
    *)
      BACKUP_FILE_NAME=$file
      ;;
  esac
  case "$BACKUP_FILE_NAME" in
    "" | . | .. | -* | *\\*) die "$label: that is not a backup file name. Give a file name, or the path of a file in the backup folder ($HOST_BACKUP_DIR)." ;;
  esac
}

# The typed passphrase. Echo is switched off ONCE, before the first prompt is
# printed, and stays off until the last answer is in: `read -s` alone turns
# it back on between two questions, and anything typed (or pasted) in that
# gap would show.
PASSPHRASE=""
TTY_STATE=""
restore_tty() {
  [ -n "$TTY_STATE" ] && stty "$TTY_STATE" 2>/dev/null
  TTY_STATE=""
  return 0
}
ask_passphrase() {
  local answer
  printf '%s' "$1" >&2
  if ! IFS= read -r -s answer; then
    printf '\n' >&2
    die "no passphrase was entered. Nothing was done."
  fi
  printf '\n' >&2
  [ -n "$answer" ] || die "the passphrase is empty. Nothing was done."
  PASSPHRASE=$answer
}
# bv_echo_off: call before the first ask_passphrase; restore_tty after the last.
bv_echo_off() {
  trap restore_tty EXIT
  trap 'exit 1' INT TERM HUP
  TTY_STATE=$(stty -g 2>/dev/null) || TTY_STATE=""
  stty -echo 2>/dev/null
}

# bv_run_with_passphrase: runs "${CMD[@]}" with the passphrase on its
# standard input — the file redirected, or the typed one written to a pipe by
# printf, a builtin. Sets RC to the command's exit status.
bv_run_with_passphrase() {
  if [ -n "$PASSFILE" ]; then
    "${CMD[@]}" < "$PASSFILE"
    RC=$?
  else
    printf '%s' "$PASSPHRASE" | "${CMD[@]}"
    RC=${PIPESTATUS[1]}
  fi
}

# bv_run_with_passphrase_waited: the same, but the command runs in the
# background and is waited for. bash runs a trap only once the foreground
# command has ended; `wait` is interrupted at once. restore.sh uses this for
# the restore itself, so that its INT/TERM/HUP trap can stop the restore
# container immediately instead of after it has finished.
# BV_CLIENT_PID is the command itself (the docker client), never a subshell
# around it: the typed passphrase is fed through a process substitution
# (printf, a builtin, in a subshell of this shell), not through a pipeline.
# The trap kills that pid, so that a client which has not created its
# container yet cannot create it afterwards.
BV_CLIENT_PID=""
bv_run_with_passphrase_waited() {
  if [ -n "$PASSFILE" ]; then
    "${CMD[@]}" < "$PASSFILE" &
  else
    "${CMD[@]}" < <(printf '%s' "$PASSPHRASE") &
  fi
  BV_CLIENT_PID=$!
  wait "$BV_CLIENT_PID"
  RC=$?
  BV_CLIENT_PID=""
}
