# shellcheck shell=bash
#
# Shared by backup.sh and restore.sh (full-backups spec §2 and §3). Source
# it; do not run it. It must be sourced AFTER scripts/compose-provider.sh
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

# bv_check_passphrase_source: PASSFILE (may be empty) and ORIG_PWD are set by
# the caller. Makes PASSFILE absolute and checks it; with no file and no
# terminal (cron) stops at once instead of waiting on a prompt.
bv_check_passphrase_source() {
  if [ -n "$PASSFILE" ]; then
    case "$PASSFILE" in /*) ;; *) PASSFILE="$ORIG_PWD/$PASSFILE" ;; esac
    { [ -f "$PASSFILE" ] && [ -r "$PASSFILE" ]; } || die "cannot read the passphrase file $PASSFILE."
    [ -s "$PASSFILE" ] || die "the passphrase file $PASSFILE is empty."
  elif [ ! -t 0 ]; then
    # Review Focus 5 (cron): nothing to prompt on. Stop now; never wait.
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
bv_run_with_passphrase_waited() {
  if [ -n "$PASSFILE" ]; then
    "${CMD[@]}" < "$PASSFILE" &
  else
    {
      printf '%s' "$PASSPHRASE" | "${CMD[@]}"
      exit "${PIPESTATUS[1]}"
    } &
  fi
  wait $!
  RC=$?
}
