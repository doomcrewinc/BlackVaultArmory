#!/bin/bash
# Full backups (spec 3c) on REAL Linux Docker: backup.sh, restore.sh and
# reencrypt-files.sh against the image built in CI, on real containers.
# Run by the `encryption-key-linux` job in .github/workflows/ci.yml, from the
# repository root, right AFTER scripts/ci/encryption-key-linux.sh: that
# script's install (/home/bvtest/app: SQLite, a rotated key, an admin, seeded
# rows, four encrypted uploads) is this script's install A, and its test user
# (uid 1234, not the container's 1001) runs every wrapper here too.
#
# A sibling script rather than more steps in that one: that script proves
# key handling and reads top to bottom as one story; this one is as long
# again and about something else. It shares the job because it needs the
# image that job builds and the install it leaves.
#
# Installs (one runs at a time: docker-compose.yml fixes the container names):
#   A  app    SQLite      the source; made by encryption-key-linux.sh
#   B  app-b  SQLite      another key: restore target, rollback, re-encrypt
#   C  app-c  PostgreSQL  another key: restore of A's backup, then its own backups
#   D  app-d  PostgreSQL  another key: restore of C's backup, then the rollback
#
# What it proves (the numbers are the step titles below):
#   1. Seed: A gets 190 more rows and six more uploads (one over 1 MiB, so
#      the archive has more than one chunk).
#   2. backup.sh --passphrase-file with the app running (compose exec) and
#      stopped (compose run): exit 0, one parseable OK line, the .bvb is in the
#      backup folder, 1001:1001 mode 600 in a 700 folder (on BOTH paths: the
#      exec path once wrote 1001:65533), the passphrase is in
#      no process listing, process environment or `docker inspect` sampled
#      while it ran; --verify through the wrapper; exit 2 while a lock is held.
#   6. --keep (ruling R32): --verify of a corrupted copy exits 1; a backup
#      that FAILS mid-run with --keep 1 deletes nothing; --keep 2 over good
#      runs leaves exactly the two newest.
#   7. No terminal: backup.sh without --passphrase-file exits 1 at once (under
#      env -i, stdin /dev/null); restore.sh without --yes exits 1 before
#      anything is checked or stopped.
#   5. On B: a wrong passphrase and a truncated archive exit 1, the app is
#      never stopped and nothing changes.
#   3. restore.sh --yes onto B (another key): every file is served by the app
#      with its original sha256, the row counts match per table, every file on
#      disk is under B's key, the RESTORE audit entry exists, .pre-restore-<ts>
#      holds B's previous files, no RECOVERY file is left.
#   4. A restore onto B that FAILS after its database step has committed
#      (uploads/documents is a mount point, so the folder swap gets EBUSY):
#      exit 1, the database and the uploads are as before, the app runs again.
#   8. reencrypt-files.sh --from-key-file: A's raw uploads folder dropped into
#      B is re-encrypted under B's key (exit 0), served intact, accepted by the
#      next start; a second run exits 3. And without it, the start refuses.
#   9. PostgreSQL: A's backup restored onto C; backup.sh on C (running and
#      stopped); C's backup restored onto D; then the failing restore on D,
#      whose rollback is pg_dump → psql into a side database → drop/rename.
#  10. The backup folder somewhere else (BLACKVAULT_BACKUP_DIR), on D: a FAT
#      filesystem that belongs to another uid (chown refused, chmod refused,
#      no hard links): the entrypoint warns, the backup works and warns about
#      the mode, --keep prunes, --verify passes; a FAT filesystem mounted for
#      uid 1001 (no hard links): works without a warning; and a path that is
#      NOT mounted: Docker creates it on the local disk and the backup lands
#      there without an error (the README's NAS warning).
#
# A check that fails is reported and the script goes on where it safely can,
# so one run shows everything that is wrong; it then exits 1.
set -uo pipefail
# No `set -e`: every command whose failure matters is checked where it runs
# (fail / bad / expect), and the wrappers' exit codes are what is under test.

TEST_USER=bvtest
HOME_DIR=/home/$TEST_USER
A=$HOME_DIR/app
B=$HOME_DIR/app-b
C=$HOME_DIR/app-c
D=$HOME_DIR/app-d
BASE=http://localhost:3000
WORK=$(mktemp -d)
PASSFILE=$HOME_DIR/ci-backup-passphrase
# Not exported, and only ever handled by builtins: the sampler below looks
# for it in every process's arguments and environment.
PASS_ASCII="ci backup passphrase"
PASSPHRASE="$PASS_ASCII ünï 0123456789"
ADMIN_PASSWORD="ci-admin-password-1234"
FAILED=0
CUR=$A
declare -A PROVIDER=()

step() { echo; echo "::group::$*"; }
endstep() { echo "::endgroup::"; }
# fail: cannot go on. bad: recorded, the run goes on and exits 1 at the end.
# Both write to standard error: several helpers are called inside $(...).
fail() { echo "::error::$*" >&2; diagnostics >&2; exit 1; }
bad() { echo "::error::$*" >&2; FAILED=$((FAILED + 1)); }
ok() { echo "  ok   $*"; }
# expect DESCRIPTION CONDITION...: runs the condition, records the outcome.
expect() {
  local what=$1
  shift
  if "$@"; then ok "$what"; elif [ "$1" = "eq" ]; then bad "$what — got '$2', want '$3'"; else bad "$what"; fi
}
# secret_file PATH < CONTENT: a file of the test user's, mode 600. The chmod is
# needed: the runner's home folders carry a default ACL, which overrides umask.
secret_file() { sudo -u "$TEST_USER" bash -c "umask 077 && cat > '$1' && chmod 600 '$1'"; }
has() { grep -q -- "$2" <<<"$1"; }
hasf() { grep -qF -- "$2" <<<"$1"; }
eq() { [ "$1" = "$2" ]; }
as_in() { local dir=$1; shift; sudo -u "$TEST_USER" -H bash -c "cd '$dir' && $*"; }

# Whatever ends this script (a failed check that cannot go on, a kill, the
# job's time limit): stop the sampler and take away every mount it made, so
# nothing is left mounted on the runner.
cleanup() {
  local m
  [ -z "${SAMPLER:-}" ] || kill "$SAMPLER" 2>/dev/null || true
  for m in "$B/data/uploads/documents" "$D/data/uploads/documents" /mnt/bv-fat-foreign /mnt/bv-fat-own; do
    if mountpoint -q "$m" 2>/dev/null; then sudo umount "$m" 2>/dev/null || sudo umount -l "$m" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

diagnostics() {
  echo "::group::diagnostics (install $CUR)"
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' || true
  as_in "$CUR" "docker compose logs --no-color --tail 120" 2>&1 || true
  for d in "$CUR/data" "$CUR/data/backups" "$CUR/data/uploads" "$CUR/backups"; do
    echo "--- $d"; sudo ls -la "$d" 2>&1 || true
  done
  echo "::endgroup::"
}

# wrap DIR COMMAND: runs a wrapper as the test user, without a terminal.
# Sets OUT (standard output), ERR (standard error) and RC, and shows them.
wrap() {
  local dir=$1
  shift
  RC=0
  OUT=$(timeout 900 sudo -u "$TEST_USER" -H bash -c "cd '$dir' && $*" 2>"$WORK/stderr" </dev/null) || RC=$?
  ERR=$(cat "$WORK/stderr")
  echo "  \$ $*   → exit $RC"
  [ -z "$OUT" ] || sed 's/^/  out| /' <<<"$OUT"
  grep -v '^ Container \|^ Network \|^ Volume ' <<<"$ERR" | grep -v '^[[:space:]]*$' | tail -n 30 | cut -c1-600 | sed 's/^/  err| /' || true
}

# ---- the app ----
wait_up() {
  local code=""
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health" || true)
    [ "$code" = "200" ] && return 0
    sleep 2
  done
  fail "$CUR: the app did not answer /api/health with 200 (last: ${code:-none})"
}
up() { as_in "$CUR" "docker compose up -d" >/dev/null 2>&1 || fail "$CUR: docker compose up -d failed"; wait_up; }
down() { as_in "$CUR" "docker compose down" >/dev/null 2>&1 || true; }
app_instance() { docker inspect -f '{{.Id}} {{.State.StartedAt}} {{.State.Running}}' blackvault 2>/dev/null || echo none; }
app_running() { [ "$(docker inspect -f '{{.State.Running}}' blackvault 2>/dev/null)" = "true" ]; }

JAR=""
login() {
  JAR="$WORK/jar-$(basename "$CUR")"
  rm -f "$JAR"
  local code
  code=$(curl -sS -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' -H "Origin: $BASE" \
    -d "$(jq -n --arg p "$ADMIN_PASSWORD" '{username: "ciadmin", password: $p}')" \
    -o "$WORK/login.json" -w '%{http_code}' "$BASE/api/auth/login")
  [ "$code" = "200" ] || fail "$CUR: login: HTTP $code $(cat "$WORK/login.json")"
}
make_admin() {
  JAR="$WORK/jar-$(basename "$CUR")"
  rm -f "$JAR"
  local logs token code
  logs=$(as_in "$CUR" "docker compose logs --no-color blackvault" 2>&1)
  token=$(grep -o 'Setup token: [A-Z0-9-]*' <<<"$logs" | tail -1 | cut -d' ' -f3 || true)
  [ -n "$token" ] || fail "$CUR: no setup token in the log"
  code=$(curl -sS -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' -H "Origin: $BASE" \
    -d "$(jq -n --arg c "$token" --arg p "$ADMIN_PASSWORD" '{setupCode: $c, username: "ciadmin", displayName: "CI Admin", password: $p}')" \
    -o "$WORK/setup.json" -w '%{http_code}' "$BASE/api/auth/setup")
  [ "$code" = "201" ] || fail "$CUR: setup: HTTP $code $(cat "$WORK/setup.json")"
}

# upload_image FILE ENTITY-TYPE ENTITY-ID → prints the URL
upload_image() {
  local code
  code=$(curl -sS -b "$JAR" -H "Origin: $BASE" -F "file=@$1;type=image/png" -F "entityType=$2" -F "entityId=$3" \
    -o "$WORK/up.json" -w '%{http_code}' "$BASE/api/images/upload")
  [ "$code" = "201" ] || fail "$CUR: image upload: HTTP $code $(cat "$WORK/up.json")"
  jq -r .url "$WORK/up.json"
}
# upload_pdf FILE NAME [firearmId] → prints the URL
upload_pdf() {
  local code extra=()
  [ -z "${3:-}" ] || extra=(-F "firearmId=$3")
  code=$(curl -sS -b "$JAR" -H "Origin: $BASE" -F "file=@$1;type=application/pdf" -F "name=$2" "${extra[@]}" \
    -o "$WORK/up.json" -w '%{http_code}' "$BASE/api/documents/upload")
  [ "$code" = "201" ] || fail "$CUR: document upload: HTTP $code $(cat "$WORK/up.json")"
  jq -r .fileUrl "$WORK/up.json"
}
# make_png FILE BYTES: a real RGB PNG of random pixels, about BYTES of raw pixel data (pictures are decoded and re-saved on upload).
make_png() {
  local file="$1" bytes="$2"
  python3 - "$file" "$bytes" <<'PYEOF'
import os, struct, sys, zlib


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


width = 64
height = max(1, int(sys.argv[2]) // (width * 3))
rows = b"".join(b"\0" + os.urandom(width * 3) for _ in range(height))
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(rows, 1))
    + chunk(b"IEND", b"")
)
with open(sys.argv[1], "wb") as out:
    out.write(png)
PYEOF
}
make_pdf() { { printf '%%PDF-1.4\n'; head -c "$2" /dev/urandom; } >"$1"; }

# served_by_app < URLS: "url sha256 bytes" per line, each fetched through the
# running app with the admin's session (so decrypted with THIS install's key).
served_by_app() {
  local url code
  while IFS= read -r url; do
    code=$(curl -sS -b "$JAR" -o "$WORK/body" -w '%{http_code}' "$BASE$url" || true)
    if [ "$code" = "200" ]; then
      echo "$url $(sha256sum <"$WORK/body" | cut -d' ' -f1) $(stat -c %s "$WORK/body")"
    else
      echo "$url HTTP-$code -"
    fi
  done
}

# ---- the uploads volume (uid 1001: every read goes through sudo) ----
magic_of() { sudo head -c4 "$1" | tr -d '\0'; }
file_key_id() { sudo dd if="$1" bs=1 skip=5 count=8 status=none; }
key_id_of() { sudo cat "$1" | tr -d '[:space:]' | xxd -r -p | sha256sum | cut -c1-8; }
# The URL of every file under images/ and documents/ of install $1.
urls_of() {
  sudo bash -c "cd '$1/data/uploads' && { find images -type f | sed 's|^|/uploads/|'; find documents -type f | sed 's|^documents/|/api/files/documents/|'; }" | LC_ALL=C sort
}
# uploads_under_key DIR KEY-ID COUNT: exactly COUNT files under images/ and
# documents/, each BVF1 under KEY-ID, mode 600, owned by uid 1001.
uploads_under_key() {
  local up="$1/data/uploads" key=$2 want=$3 f n=0 wrong=0
  while IFS= read -r -d '' f; do
    n=$((n + 1))
    if [ "$(magic_of "$f")" != "BVF1" ] || [ "$(file_key_id "$f")" != "$key" ] || [ "$(sudo stat -c '%u %a' "$f")" != "1001 600" ]; then
      wrong=$((wrong + 1))
      echo "  not BVF1 under $key, 1001, 600: $f ($(magic_of "$f") $(file_key_id "$f") $(sudo stat -c '%u %a' "$f"))"
    fi
  done < <(sudo find "$up/images" "$up/documents" -type f -print0)
  [ "$wrong" = "0" ] && [ "$n" = "$want" ]
}
# Everything under the uploads folder: type, path, owner, mode, size; then the
# sha256 of every file. Two equal outputs = the same tree, byte for byte.
tree_of() {
  sudo bash -c "cd '$1/data/uploads' && find . -printf '%y %p %u:%g %m %s\n' | LC_ALL=C sort && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum"
}
same_text() { # same_text WHAT BEFORE AFTER
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    diff <(echo "$2") <(echo "$3") | head -n 40 | sed 's/^/  diff| /' || true
  fi
}

# ---- the database ----
# sql DIR QUERY: unaligned, '|' between columns, on either provider.
sql() {
  if [ "${PROVIDER[$1]}" = "sqlite" ]; then
    sudo sqlite3 "$1/data/db/vault.db" "$2"
  else
    as_in "$1" "docker compose exec -T db psql -At -q -v ON_ERROR_STOP=1 -U blackvault -d blackvault" <<<"$2"
  fi
}
tables_of() {
  if [ "${PROVIDER[$1]}" = "sqlite" ]; then
    sql "$1" "SELECT name FROM sqlite_master WHERE type = 'table';"
  else
    sql "$1" "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
  fi | grep -v '^_prisma\|^sqlite_' | LC_ALL=C sort
}
# Rows per table, for every table a backup holds (src/lib/backup/models.ts:
# everything except BACKUP_EXCLUDED_MODELS).
counts_of() {
  local t q=""
  for t in $(tables_of "$1" | grep -vx 'AppSettings\|User\|Session\|AuthToken\|AuditEvent'); do
    q="$q${q:+ UNION ALL }SELECT '$t' AS t, count(*) AS n FROM \"$t\""
  done
  sql "$1" "$q ORDER BY 1;" | LC_ALL=C sort
}
# One line per table: its name and the sha256 of all its rows — every table
# but the two the running app writes by itself (AuditEvent, Session) — and
# the schema. Equal before and after = the database content is unchanged.
fingerprint_of() {
  local t
  for t in $(tables_of "$1" | grep -vx 'Session\|AuditEvent'); do
    if [ "${PROVIDER[$1]}" = "sqlite" ]; then
      echo "$t $(sql "$1" "SELECT * FROM \"$t\" ORDER BY 1;" | sha256sum | cut -c1-16)"
    else
      echo "$t $(sql "$1" "COPY (SELECT * FROM \"$t\" ORDER BY 1) TO STDOUT;" | sha256sum | cut -c1-16)"
    fi
  done
  if [ "${PROVIDER[$1]}" = "sqlite" ]; then
    echo "schema $(sql "$1" "SELECT type, name, sql FROM sqlite_master ORDER BY type, name;" | sha256sum | cut -c1-16)"
  else
    # \restrict / \unrestrict carry a random token in every dump.
    echo "schema $(as_in "$1" "docker compose exec -T db pg_dump -U blackvault -d blackvault --schema-only" | grep -v '^\\\(un\)\?restrict ' | sha256sum | cut -c1-16)"
  fi
}
audit_count() { sql "$1" "SELECT count(*) FROM \"AuditEvent\" WHERE action = '$2' AND CAST(changes AS TEXT) LIKE '%\"full\":true%' AND CAST(changes AS TEXT) LIKE '%$3%';"; }

# ---- installs ----
# new_install DIR sqlite|postgres: a fresh install with its own key, started.
new_install() {
  local dir=$1 provider=$2 name pw
  name=$(basename "$dir")
  CUR=$dir
  PROVIDER[$dir]=$provider
  sudo cp -a "$PWD" "$dir"
  sudo chown -R "$TEST_USER:$TEST_USER" "$dir"
  sudo rm -rf "$dir/secrets/blackvault_encryption_key"* "$dir/backups" "$dir/data" "$dir/.env"
  sudo install -d -o 1001 -g 1001 "$dir/data/db" "$dir/data/uploads"
  sudo chown "$TEST_USER:$TEST_USER" "$dir/data"
  as_in "$dir" "umask 077 && cat > .env" <<EOF
DATA_DIR=$dir/data
PORT=3000
BLACKVAULT_DB_PROVIDER=$provider
BLACKVAULT_PUBLIC_URL=http://localhost:3000
BLACKVAULT_TRUSTED_PROXIES=
BLACKVAULT_DIRECT_ACCESS_INITIAL=on
BLACKVAULT_ALLOW_DIRECT_ACCESS=true
EOF
  if [ "$provider" = "postgres" ]; then
    pw=$(openssl rand -hex 24)
    as_in "$dir" "cat >> .env" <<EOF
COMPOSE_PROFILES=postgres
BLACKVAULT_POSTGRES_PASSWORD=$pw
BLACKVAULT_DATABASE_URL=postgresql://blackvault:$pw@db:5432/blackvault
EOF
  fi
  as_in "$dir" "umask 077 && openssl rand -hex 32 > secrets/blackvault_encryption_key && chmod 600 secrets/blackvault_encryption_key .env"
  # The image the job built for install A, under the name this folder's
  # compose project expects: no second build.
  docker tag app-blackvault "$name-blackvault"
  as_in "$dir" "docker compose config --images" | grep -qx "$name-blackvault" || fail "$dir: the compose project does not use the image $name-blackvault"
  up
  expect "$name: the fresh backup folder is 1001:1001 mode 700" eq "$(sudo stat -c '%u:%g %a' "$dir/data/backups")" "1001:1001 700"
  make_admin
}
# put_backup SOURCE-FILE DIR: the archive into DIR's backup folder, as the app user's.
put_backup() { sudo install -o 1001 -g 1001 -m 600 "$1" "$2/data/backups/$(basename "$1")"; }
recovery_files() { sudo find "$1/backups" -maxdepth 1 -name 'restore-*-RECOVERY.txt' 2>/dev/null | wc -l | tr -d ' '; }
restore_leftovers() { sudo find "$1/data/uploads" -maxdepth 1 -name '.restore-*' | wc -l | tr -d ' '; }
published() { sudo find "$1/data/backups" -maxdepth 1 -name 'blackvault-full-*.bvb' -printf '%f\n' | LC_ALL=C sort; }
backup_folder() { sudo bash -c "cd '$1/data/backups' && ls -A | LC_ALL=C sort && sha256sum -- * 2>/dev/null"; }

# ---- the passphrase must never be visible ----
SAMPLES="$WORK/samples"
SAMPLER=""
# Every process's arguments AND environment (ps e, as root), and every
# container's `docker inspect`, over and over while a wrapper runs.
sampler_start() {
  : >"$SAMPLES"
  (
    while :; do
      sudo ps axeww 2>/dev/null
      ids=$(docker ps -aq 2>/dev/null) || ids=""
      # shellcheck disable=SC2086 # a list of container ids
      [ -z "$ids" ] || docker inspect $ids 2>/dev/null
      echo "--sample--"
    done >>"$SAMPLES"
  ) &
  SAMPLER=$!
}
sampler_stop() {
  [ -n "$SAMPLER" ] || return 0
  kill "$SAMPLER" 2>/dev/null || true
  wait "$SAMPLER" 2>/dev/null || true
  SAMPLER=""
}
# sampler_verdict PROGRAM: the samples really saw the wrapper and the program
# (so a passphrase on a command line WOULD have been seen), and do not hold it.
sampler_verdict() {
  local n
  n=$(grep -c -- '--sample--' "$SAMPLES" || true)
  echo "  $n samples, $(wc -c <"$SAMPLES") bytes"
  expect "the samples saw the wrapper's own command line (--passphrase-file)" grep -qF -- "--passphrase-file $PASSFILE" "$SAMPLES"
  expect "the samples saw the program inside the container ($1)" grep -qF -- "$1" "$SAMPLES"
  expect "the samples saw a container's environment (docker inspect)" grep -qF -- '"DB_PROVIDER=' "$SAMPLES"
  # Bytes, not characters (LC_ALL=C), and the ASCII part by itself too: the
  # passphrase holds non-ASCII letters, and the proof must not depend on the
  # locale or on how a tool printed them.
  if LC_ALL=C grep -qF -- "$PASSPHRASE" "$SAMPLES" || LC_ALL=C grep -qF -- "$PASS_ASCII" "$SAMPLES"; then
    bad "the passphrase is visible in a process listing or a docker inspect"
  else
    ok "the passphrase is in no sampled command line, process environment or docker inspect"
  fi
}

OK_LINE='^BLACKVAULT_FULL_BACKUP_OK file=(blackvault-full-[0-9]{8}-[0-9]{6}\.bvb) files=([0-9]+) bytes=([0-9]+) archive_bytes=([0-9]+) skipped=([0-9]+) unreadable=([0-9]+)$'
VERIFIED_LINE='^BLACKVAULT_FULL_BACKUP_VERIFIED file=(blackvault-full-[0-9]{8}-[0-9]{6}\.bvb) files=([0-9]+) bytes=([0-9]+) archive_bytes=([0-9]+)$'
RESTORE_LINE='^BLACKVAULT_FULL_RESTORE_OK file=(blackvault-full-[0-9]{8}-[0-9]{6}\.bvb) files=([0-9]+) bytes=([0-9]+) pre_restore=(\.pre-restore-[0-9]{8}-[0-9]{6})$'

# good_backup DIR WANT-FILES WANT-BYTES [FOLDER [FILE-STAT [FOLDER-STAT]]]:
# checks RC/OUT of a backup.sh run that has just finished, and the file it
# wrote. Sets NEW to the file name. FOLDER is the backup folder on the host
# (default DIR/data/backups); the STATs are `owner:group mode` (defaults: the
# file 1001:1001 600, the folder 1001:1001 700).
NEW=""
good_backup() {
  local dir=$1 f folder=${4:-$1/data/backups} file_stat=${5:-1001:1001 600} folder_stat=${6:-1001:1001 700}
  NEW=""
  expect "exit 0" eq "$RC" 0
  if [[ "$OUT" =~ $OK_LINE ]]; then
    NEW=${BASH_REMATCH[1]}
    ok "standard output is exactly the OK line"
    expect "files=$2 bytes=$3 skipped=0 unreadable=0" eq "${BASH_REMATCH[2]} ${BASH_REMATCH[3]} ${BASH_REMATCH[5]} ${BASH_REMATCH[6]}" "$2 $3 0 0"
    f="$folder/$NEW"
    expect "$NEW is in the backup folder $folder" sudo test -f "$f"
    # Also on the exec path: backup.sh passes -u 1001:1001 (with -u 1001 alone the group was 65533).
    expect "it is $file_stat" eq "$(sudo stat -c '%u:%g %a' "$f")" "$file_stat"
    expect "archive_bytes is its size" eq "$(sudo stat -c %s "$f")" "${BASH_REMATCH[4]}"
    # A 4-byte length, then the header JSON in clear (src/lib/encryption/core.mjs).
    expect "it starts with the full-backup header" eq "$(sudo head -c 400 "$f" | grep -a -c '"format":"blackvault-full-backup"')" 1
  else
    bad "standard output is not exactly one BLACKVAULT_FULL_BACKUP_OK line"
  fi
  expect "the backup folder is $folder_stat" eq "$(sudo stat -c '%u:%g %a' "$folder")" "$folder_stat"
  expect "no .partial and no lock are left" eq "$(sudo find "$folder" -maxdepth 1 \( -name '*.partial' -o -name '.full-backup.lock*' \) | wc -l | tr -d ' ')" 0
}

# good_restore DIR NAME WANT-FILES: checks RC/OUT of a restore.sh run that has
# just finished. Sets PRE to the .pre-restore folder name.
PRE=""
good_restore() {
  PRE=""
  expect "exit 0" eq "$RC" 0
  if [[ "$OUT" =~ $RESTORE_LINE ]]; then
    PRE=${BASH_REMATCH[4]}
    ok "standard output is exactly the RESTORE_OK line"
    expect "file=$2 files=$3" eq "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}" "$2 $3"
  else
    bad "standard output is not exactly one BLACKVAULT_FULL_RESTORE_OK line"
  fi
  expect "no RECOVERY file is left" eq "$(recovery_files "$1")" 0
  expect "no .restore-* staging folder or marker is left" eq "$(restore_leftovers "$1")" 0
}

# restored_matches_a DIR KEY-ID: after a restore of A's data onto DIR (running).
restored_matches_a() {
  same_text "row counts per table equal install A's" "$A_COUNTS" "$(counts_of "$1")"
  same_text "every file is served by the app with its original sha256" "$A_SERVED" "$(served_by_app <<<"$A_URLS")"
  expect "every file on disk is BVF1 under this install's key $2 ($A_FILES files, 1001, 600)" uploads_under_key "$1" "$2" "$A_FILES"
  local serials n
  serials=$(curl -sS -b "$JAR" "$BASE/api/firearms" | jq -r '[.. | objects | .serialNumber? // empty] | unique | join(" ")' || true)
  for n in 1 2 3; do
    expect "the app decrypts the restored serial number CI-SERIAL-F$n with this install's key" hasf " $serials " " CI-SERIAL-F$n "
  done
  expect "every stored serial is bv2 under key $2" eq "$(sql "$1" "SELECT count(*) FROM \"Firearm\" WHERE \"serialNumber\" LIKE 'bv2:$2:%';")" 3
}

# failing_restore DIR NAME: the restore of NAME onto DIR (running, logged in)
# must fail AFTER its database step and be rolled back completely.
# The oid of the database named blackvault. A database that was dropped and
# another one renamed into its place has a different oid.
pg_database_oid() {
  as_in "$1" "docker compose exec -T db psql -At -q -U blackvault -d postgres" <<<"SELECT oid FROM pg_database WHERE datname = 'blackvault';"
}
failing_restore() {
  local dir=$1 name=$2 docs="$1/data/uploads/documents" before_fp before_tree extra_url extra_sha before_oid="" after_oid=""
  # Make the install differ from the backup first, or "unchanged" proves nothing.
  sql "$dir" "DELETE FROM \"AmmoStock\" WHERE id LIKE 'ci-ammo-10%';" >/dev/null
  make_png "$WORK/extra.png" 5000
  extra_url=$(upload_image "$WORK/extra.png" ammo ci-ammo-1)
  # The app re-saves a picture, so the reference is what it serves right after the upload.
  extra_sha=$(served_by_app <<<"$extra_url" | cut -d' ' -f2)
  expect "before: 139 AmmoStock rows (the backup holds 150)" eq "$(sql "$dir" "SELECT count(*) FROM \"AmmoStock\";")" 139
  before_fp=$(fingerprint_of "$dir")
  before_tree=$(tree_of "$dir")
  [ "${PROVIDER[$dir]}" != "postgres" ] || before_oid=$(pg_database_oid "$dir")
  # The black-box failure. documents/ becomes a mount point (a bind mount of
  # itself), as it would be with a NAS share mounted there. Docker's bind of
  # the uploads folder carries it into the container, where rename(2) of a
  # mount point is EBUSY. The restore program swaps images/ first, then
  # documents/: by then its database transaction has COMMITTED and its marker
  # exists, so this exercises the program's own undo of the images/ swap, the
  # wrapper's uploads rollback and the wrapper's DATABASE rollback.
  sudo mount --bind "$docs" "$docs"
  wrap "$dir" "./restore.sh $name --passphrase-file $PASSFILE --yes"
  sudo umount "$docs"
  expect "exit 1" eq "$RC" 1
  expect "nothing on standard output" eq "$OUT" ""
  expect "the restore program failed at the folder swap (EBUSY), after its database step" hasf "$ERR" "EBUSY"
  expect "it says the records were already replaced" hasf "$ERR" "The database records were already replaced and must be restored from the snapshot."
  expect "the wrapper saw the marker: 'after it had reached the database'" hasf "$ERR" "after it had reached the database. Putting the uploads and the database back from the snapshot"
  expect "the uploads were checked against the snapshot" hasf "$ERR" "Uploads restored and checked against the snapshot"
  if [ "${PROVIDER[$dir]}" = "sqlite" ]; then
    expect "the SQLite database was put back from the snapshot" hasf "$ERR" "Database restored from the snapshot: /bv-backups/blackvault-"
  fi
  expect "the last line says it was put back and BlackVault was started again" hasf "$(tail -n 1 <<<"$ERR")" "so nothing is changed. BlackVault was started again."
  wait_up
  expect "the app is running again" app_running
  same_text "the database content is as before (every table but AuditEvent/Session, and the schema)" "$before_fp" "$(fingerprint_of "$dir")"
  same_text "the uploads folder is byte-identical (every path, owner, mode, size, sha256)" "$before_tree" "$(tree_of "$dir")"
  expect "still 139 AmmoStock rows" eq "$(sql "$dir" "SELECT count(*) FROM \"AmmoStock\";")" 139
  expect "the file uploaded after the backup is still served" eq "$(served_by_app <<<"$extra_url" | cut -d' ' -f2)" "$extra_sha"
  expect "no RECOVERY file is left" eq "$(recovery_files "$dir")" 0
  expect "no .restore-* staging folder or marker is left" eq "$(restore_leftovers "$dir")" 0
  expect "the failed run left no RESTORE audit entry (still $3, from the earlier successful restore)" eq "$(audit_count "$dir" RESTORE "$name")" "$3"
  if [ "${PROVIDER[$dir]}" = "postgres" ]; then
    # Direct proof that the rollback's drop/rename ran: same name, another database.
    after_oid=$(pg_database_oid "$dir")
    echo "  pg_database oid of 'blackvault': before the failing restore $before_oid, after the rollback $after_oid"
    if [[ "$before_oid" =~ ^[0-9]+$ ]] && [[ "$after_oid" =~ ^[0-9]+$ ]] && [ "$before_oid" != "$after_oid" ]; then
      ok "PostgreSQL: the database named blackvault is a DIFFERENT database now (oid $before_oid → $after_oid): the snapshot was loaded into a new one and swapped in"
    else bad "PostgreSQL: the database oid did not change ($before_oid → $after_oid): the drop/rename did not run"; fi
    expect "PostgreSQL: no blackvault_rollback database is left, and blackvault is owned by blackvault" eq \
      "$(as_in "$dir" "docker compose exec -T db psql -At -q -U blackvault -d postgres" <<<"SELECT d.datname || ':' || r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname LIKE 'blackvault%' ORDER BY 1;" | tr '\n' ' ')" "blackvault:blackvault "
  fi
}

# ════════════════════════════════════════════════════════════════════════════
step "0. install A as encryption-key-linux.sh left it"
PROVIDER[$A]=sqlite
[ -f "$A/data/db/vault.db" ] || fail "$A has no database: run scripts/ci/encryption-key-linux.sh first"
docker image inspect app-blackvault >/dev/null 2>&1 || fail "the image app-blackvault does not exist"
command -v jq >/dev/null && command -v sqlite3 >/dev/null && command -v xxd >/dev/null || fail "jq, sqlite3 and xxd are needed"
printf '%s\n' "$PASSPHRASE" | secret_file "$PASSFILE"
expect "the passphrase file is 600 $TEST_USER" eq "$(sudo stat -c '%a %U' "$PASSFILE")" "600 $TEST_USER"
A_KEY_ID=$(key_id_of "$A/secrets/blackvault_encryption_key")
echo "install A key id: $A_KEY_ID"
endstep

step "1. seed install A: 190 more rows, six more uploads"
sudo sqlite3 "$A/data/db/vault.db" ".read scripts/ci/full-backup-seed.sql" || fail "seed failed"
[ "$(sudo stat -c '%u' "$A/data/db/vault.db")" = "1001" ] || fail "vault.db is no longer owned by 1001"
up
login
expect "the backup folder Docker created is 1001:1001 mode 700 (the entrypoint)" eq "$(sudo stat -c '%u:%g %a' "$A/data/backups")" "1001:1001 700"
if as_in "$A" "ls data/backups" >/dev/null 2>&1; then bad "the host user can list the backup folder"; else ok "the host user ($TEST_USER) cannot list the backup folder"; fi
# One over 1 MiB (the archive's chunk size) and one of several MiB.
make_png "$WORK/a1.png" 3000000
make_png "$WORK/a2.png" 1048576
make_png "$WORK/a3.png" 700
make_png "$WORK/a4.png" 64
make_pdf "$WORK/a5.pdf" 2500000
make_pdf "$WORK/a6.pdf" 9000
NEW_URLS=$(
  upload_image "$WORK/a1.png" firearm ci-f1
  upload_image "$WORK/a2.png" accessory ci-a1
  upload_image "$WORK/a3.png" ammo ci-ammo-1
  upload_image "$WORK/a4.png" firearm ci-f2
  upload_pdf "$WORK/a5.pdf" "CI big PDF" ci-f1
  upload_pdf "$WORK/a6.pdf" "CI small PDF"
) || fail "uploads failed"
A_URLS=$(urls_of "$A")
A_FILES=$(wc -l <<<"$A_URLS" | tr -d ' ')
A_SERVED=$(served_by_app <<<"$A_URLS")
echo "$A_SERVED" | sed 's/^/  /'
expect "install A holds 10 uploads" eq "$A_FILES" 10
if has "$A_SERVED" " HTTP-"; then fail "install A does not serve all its own files"; fi
A_BYTES=$(awk '{s += $3} END {print s}' <<<"$A_SERVED")
# The two PDFs are served with exactly the bytes that were sent; the pictures are
# decoded and re-saved by the app, so each is only checked to be served.
i=0
for f in a1.png a2.png a3.png a4.png a5.pdf a6.pdf; do
  i=$((i + 1))
  url=$(sed -n "${i}p" <<<"$NEW_URLS")
  if [[ "$f" == *.pdf ]]; then
    expect "$f is served back as uploaded ($url)" hasf "$A_SERVED" "$url $(sha256sum <"$WORK/$f" | cut -d' ' -f1) "
  else
    expect "$f is served ($url)" hasf "$A_SERVED" "$url "
  fi
done
A_COUNTS=$(counts_of "$A")
echo "$A_COUNTS" | tr '\n' ' '; echo
for want in "Firearm|3" "Accessory|2" "Gear|2" "AmmoStock|150" "RoundCountLog|40" "Document|4"; do
  expect "install A: $want" hasf "$A_COUNTS" "$want"
done
expect "A's uploads are all under A's key" uploads_under_key "$A" "$A_KEY_ID" "$A_FILES"
endstep

step "2a. backup.sh --passphrase-file, app RUNNING (docker compose exec)"
sampler_start
wrap "$A" "./backup.sh --passphrase-file $PASSFILE"
sampler_stop
good_backup "$A" "$A_FILES" "$A_BYTES"
BK1=$NEW
sampler_verdict "node dist/scripts/full-backup.mjs --keep 7"
expect "the app was not restarted" app_running
if sudo -u bvother cat "$A/data/backups/$BK1" >/dev/null 2>&1; then bad "another host user can read the backup"; else ok "another host user cannot read the backup"; fi
expect "BACKUP_CREATED audit entry {full:true, file, verified:true}" eq \
  "$(sql "$A" "SELECT count(*) FROM \"AuditEvent\" WHERE action = 'BACKUP_CREATED' AND changes LIKE '%\"full\":true%' AND changes LIKE '%$BK1%' AND changes LIKE '%\"verified\":true%';")" 1
endstep

step "2b. backup.sh --verify through the wrapper (a name, then a path); exit 2 while a lock is held, and restore.sh refuses before it stops the app"
wrap "$A" "./backup.sh --verify $BK1 --passphrase-file $PASSFILE"
expect "exit 0" eq "$RC" 0
if [[ "$OUT" =~ $VERIFIED_LINE ]]; then
  expect "VERIFIED line: file=$BK1 files=$A_FILES bytes=$A_BYTES" eq "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}" "$BK1 $A_FILES $A_BYTES"
else bad "standard output is not exactly one BLACKVAULT_FULL_BACKUP_VERIFIED line"; fi
# A path into a folder the host user cannot enter (0700, uid 1001).
wrap "$A" "./backup.sh --verify data/backups/$BK1 --passphrase-file $PASSFILE"
expect "exit 0 with a path into the backup folder" eq "$RC" 0
# Ruling R37: the passphrase file's encoding. $BK1 was sealed from a file
# WITHOUT a byte order mark; the same passphrase from a file WITH one (what
# Windows editors write) must open it, and a UTF-16 file must be refused.
{ printf '\xef\xbb\xbf'; sudo cat "$PASSFILE"; } | secret_file "$HOME_DIR/ci-passphrase-bom"
{ printf '\xff\xfe'; sudo cat "$PASSFILE" | iconv -f UTF-8 -t UTF-16LE; } | secret_file "$HOME_DIR/ci-passphrase-utf16"
wrap "$A" "./backup.sh --verify $BK1 --passphrase-file $HOME_DIR/ci-passphrase-bom"
expect "R37: a passphrase file with a UTF-8 BOM opens a backup sealed without one (exit 0)" eq "$RC" 0
wrap "$A" "./backup.sh --verify $BK1 --passphrase-file $HOME_DIR/ci-passphrase-utf16"
expect "R37: a UTF-16 passphrase file is refused (exit 1)" eq "$RC" 1
expect "R37: and it says to save the file as UTF-8" hasf "$ERR" "full-backup: the passphrase is not UTF-8 text"
wrap "$A" "./backup.sh --verify /etc/hostname --passphrase-file $PASSFILE"
expect "a path outside the backup folder is refused (exit 1)" eq "$RC" 1
# An empty lock with a fresh heartbeat is a backup that has just started
# (src/lib/backup/full-lock.ts, "No usable owner"): exit 2 through compose
# exec and the wrapper, and nothing is written.
sudo -u '#1001' touch "$A/data/backups/.full-backup.lock"
BEFORE=$(published "$A")
wrap "$A" "./backup.sh --passphrase-file $PASSFILE"
expect "exit 2: another backup is already running" eq "$RC" 2
expect "it says so" hasf "$ERR" "full-backup: Another full backup is already running."
same_text "nothing was written" "$BEFORE" "$(published "$A")"
# The same lock stops a restore BEFORE the app is stopped: restore.sh asks
# the running app (full-backup.mjs --lock-status) once the archive has passed
# its check.
sudo -u '#1001' touch "$A/data/backups/.full-backup.lock"
INSTANCE=$(app_instance)
wrap "$A" "./restore.sh $BK1 --yes --passphrase-file $PASSFILE"
expect "restore.sh exits 1 while the lock is held" eq "$RC" 1
expect "it shows what the running app answered" hasf "$ERR" "BLACKVAULT_FULL_BACKUP_LOCK state=held pid=0 hostname=unknown started=unknown"
expect "and says a backup is running and nothing was changed" hasf "$ERR" "ERROR: a full backup is running (the line above names it), so the restore did not start. Nothing was changed; BlackVault was not stopped."
expect "the app was never stopped (same container, same start time)" eq "$(app_instance)" "$INSTANCE"
same_text "nothing was written" "$BEFORE" "$(published "$A")"
sudo rm -f "$A/data/backups/.full-backup.lock"
endstep

step "7. no terminal: backup.sh without --passphrase-file, restore.sh without --yes"
RC=0
ERR=$(timeout 60 sudo -u "$TEST_USER" env -i PATH="$PATH" HOME="$HOME_DIR" bash -c "cd '$A' && ./backup.sh" 2>&1 </dev/null) || RC=$?
echo "  err| $ERR"
expect "backup.sh exits 1 at once (not 124: it did not wait on a prompt)" eq "$RC" 1
expect "and says why" hasf "$ERR" "ERROR: no passphrase: standard input is not a terminal"
INSTANCE=$(app_instance)
wrap "$A" "./restore.sh $BK1 --passphrase-file $PASSFILE"
expect "restore.sh without --yes exits 1" eq "$RC" 1
expect "and says --yes is needed" hasf "$ERR" "Add --yes to confirm. Nothing was done."
expect "the app was never stopped (same container, same start time)" eq "$(app_instance)" "$INSTANCE"
same_text "nothing was written" "$BK1" "$(published "$A")"
endstep

step "2c. backup.sh --passphrase-file, app STOPPED (docker compose run)"
as_in "$A" "docker compose stop blackvault" >/dev/null 2>&1 || fail "could not stop A"
sleep 1
sampler_start
wrap "$A" "./backup.sh --passphrase-file $PASSFILE"
sampler_stop
good_backup "$A" "$A_FILES" "$A_BYTES"
BK2=$NEW
sampler_verdict "node dist/scripts/full-backup.mjs --keep 7"
expect "the app is still stopped (backup.sh does not start it)" eq "$(docker inspect -f '{{.State.Running}}' blackvault)" "false"
expect "the one-off container is gone" eq "$(docker ps -aq --filter name=blackvault-run | wc -l | tr -d ' ')" 0
same_text "both backups are there" "$(printf '%s\n%s' "$BK1" "$BK2")" "$(published "$A")"
endstep

step "6a. backup.sh --verify on a corrupted copy of the newest backup: exit 1 (R32 a)"
SIZE=$(sudo stat -c %s "$A/data/backups/$BK2")
OFFSET=$((SIZE / 2))
sudo cp -p "$A/data/backups/$BK2" "$A/data/backups/ci-corrupt.bvb"
BYTE=$(sudo dd if="$A/data/backups/ci-corrupt.bvb" bs=1 skip="$OFFSET" count=1 status=none | xxd -p)
printf '%02x' $((0x$BYTE ^ 0xff)) | xxd -r -p | sudo dd of="$A/data/backups/ci-corrupt.bvb" bs=1 seek="$OFFSET" conv=notrunc status=none
expect "the copy differs from the original in one byte" eq "$(sudo cmp -l "$A/data/backups/$BK2" "$A/data/backups/ci-corrupt.bvb" | wc -l | tr -d ' ')" 1
wrap "$A" "./backup.sh --verify ci-corrupt.bvb --passphrase-file $PASSFILE"
expect "exit 1" eq "$RC" 1
expect "nothing on standard output" eq "$OUT" ""
expect "one full-backup: line says why" has "$ERR" "^full-backup: "
sudo rm -f "$A/data/backups/ci-corrupt.bvb"
endstep

step "6b. a backup that FAILS with --keep 1 deletes nothing (R32 b)"
BEFORE=$(backup_folder "$A")
# Mid-run: a row the backup cannot read. A serial number stored in plain text
# in an encrypted database is refused when the records are exported — after
# the lock is taken and the backup folder has been checked.
sudo sqlite3 "$A/data/db/vault.db" "INSERT INTO \"Firearm\" (\"id\", \"name\", \"manufacturer\", \"model\", \"caliber\", \"serialNumber\", \"type\", \"acquisitionDate\", \"updatedAt\")
  VALUES ('ci-plain', 'CI Plain', 'Acme', 'X', '9mm', 'CI-PLAIN-SERIAL', 'PISTOL', 1700000000000, 1700000000000);"
wrap "$A" "./backup.sh --passphrase-file $PASSFILE --keep 1"
expect "exit 1" eq "$RC" 1
expect "nothing on standard output" eq "$OUT" ""
expect "it failed while exporting the records" hasf "$ERR" "full-backup: Cannot decrypt Firearm.serialNumber for id ci-plain"
same_text "the backup folder is unchanged: both backups, same bytes, no .partial, no lock" "$BEFORE" "$(backup_folder "$A")"
sudo sqlite3 "$A/data/db/vault.db" "DELETE FROM \"Firearm\" WHERE id = 'ci-plain';"
# Before anything starts: a passphrase under 12 characters.
printf 'short\n' | secret_file "$HOME_DIR/ci-short-passphrase"
wrap "$A" "./backup.sh --passphrase-file $HOME_DIR/ci-short-passphrase --keep 1"
expect "exit 1 for a passphrase that is too short" eq "$RC" 1
expect "it says so" hasf "$ERR" "full-backup: Passphrase must be at least 12 characters."
same_text "the backup folder is unchanged again" "$BEFORE" "$(backup_folder "$A")"
endstep

step "6c. --keep 2 over good runs leaves exactly the two newest (R32 c)"
sleep 1
wrap "$A" "./backup.sh --passphrase-file $PASSFILE --keep 2"
good_backup "$A" "$A_FILES" "$A_BYTES"
BK3=$NEW
expect "it says which backup it deleted" hasf "$ERR" "full-backup: deleted old backup $BK1"
same_text "left: the two newest" "$(printf '%s\n%s' "$BK2" "$BK3")" "$(published "$A")"
up
sleep 1
wrap "$A" "./backup.sh --passphrase-file $PASSFILE --keep 2"
good_backup "$A" "$A_FILES" "$A_BYTES"
BK4=$NEW
expect "it says which backup it deleted" hasf "$ERR" "full-backup: deleted old backup $BK2"
same_text "left: the two newest" "$(printf '%s\n%s' "$BK3" "$BK4")" "$(published "$A")"
sleep 1
wrap "$A" "./backup.sh --passphrase-file $PASSFILE"
good_backup "$A" "$A_FILES" "$A_BYTES"
BK5=$NEW
same_text "the default --keep 7 deletes nothing here" "$(printf '%s\n%s\n%s' "$BK3" "$BK4" "$BK5")" "$(published "$A")"
endstep

step "A: take the newest backup, the raw uploads folder and the key out; stop A"
A_BACKUP="$WORK/$BK5"
sudo cp "$A/data/backups/$BK5" "$A_BACKUP"
sudo mkdir "$WORK/a-uploads"
sudo cp -a "$A/data/uploads/images" "$A/data/uploads/documents" "$WORK/a-uploads/"
sudo install -o "$TEST_USER" -g "$TEST_USER" -m 600 "$A/secrets/blackvault_encryption_key" "$HOME_DIR/ci-a-key"
down
endstep

# ════════════════════════════════════════════════════════════════════════════
step "B: a second install (SQLite) with a DIFFERENT key, and files of its own"
new_install "$B" sqlite
B_KEY_ID=$(key_id_of "$B/secrets/blackvault_encryption_key")
echo "install B key id: $B_KEY_ID (A: $A_KEY_ID)"
[ "$B_KEY_ID" != "$A_KEY_ID" ] || fail "B has A's key"
sql "$B" "INSERT INTO \"AmmoStock\" (\"id\", \"caliber\", \"brand\", \"quantity\", \"createdAt\", \"updatedAt\") VALUES ('ci-b-ammo', '9mm', 'B Brand', 5, 1700000000000, 1700000000000);"
make_png "$WORK/b1.png" 6000
make_pdf "$WORK/b2.pdf" 6000
upload_image "$WORK/b1.png" ammo ci-b-ammo >/dev/null
upload_pdf "$WORK/b2.pdf" "B PDF" >/dev/null
B_PREVIOUS=$(sudo bash -c "cd '$B/data/uploads' && find images documents -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum")
echo "$B_PREVIOUS" | sed 's/^/  /'
expect "B holds two files of its own" eq "$(wc -l <<<"$B_PREVIOUS" | tr -d ' ')" 2
put_backup "$A_BACKUP" "$B"
endstep

step "5. on B: a wrong passphrase and a truncated archive exit 1; the app is never stopped; nothing changes"
INSTANCE=$(app_instance)
FP=$(fingerprint_of "$B")
TREE=$(tree_of "$B")
printf 'not the passphrase 0123456789\n' | secret_file "$HOME_DIR/ci-wrong-passphrase"
wrap "$B" "./restore.sh $BK5 --passphrase-file $HOME_DIR/ci-wrong-passphrase --yes"
expect "wrong passphrase: exit 1" eq "$RC" 1
expect "the program says why" hasf "$ERR" "full-backup: Wrong passphrase or damaged file."
expect "the wrapper says nothing was changed and the app was not stopped" hasf "$ERR" "did not pass the check (the reason is on the line above). Nothing was changed; BlackVault was not stopped."
sudo bash -c "head -c $(($(stat -c %s "$A_BACKUP") / 2)) '$A_BACKUP' > '$B/data/backups/ci-truncated.bvb' && chown 1001:1001 '$B/data/backups/ci-truncated.bvb' && chmod 600 '$B/data/backups/ci-truncated.bvb'"
wrap "$B" "./restore.sh ci-truncated.bvb --passphrase-file $PASSFILE --yes"
expect "truncated archive: exit 1" eq "$RC" 1
expect "the program says it is damaged or incomplete" has "$ERR" "^full-backup: .*\(damaged\|incomplete\|cut off\|truncated\)"
expect "the wrapper says nothing was changed and the app was not stopped" hasf "$ERR" "Nothing was changed; BlackVault was not stopped."
sudo rm -f "$B/data/backups/ci-truncated.bvb"
expect "the app was never stopped (same container, same start time)" eq "$(app_instance)" "$INSTANCE"
same_text "the database content is unchanged" "$FP" "$(fingerprint_of "$B")"
same_text "the uploads folder is unchanged" "$TREE" "$(tree_of "$B")"
expect "no RECOVERY file, no snapshot folder was even created" eq "$(recovery_files "$B") $(sudo test -e "$B/backups" && echo exists || echo none)" "0 none"
endstep

step "3. restore.sh --yes --passphrase-file onto B (a different key)"
# A path into the backup folder, which the host user cannot enter.
wrap "$B" "./restore.sh data/backups/$BK5 --yes --passphrase-file $PASSFILE"
good_restore "$B" "$BK5" "$A_FILES"
wait_up
expect "the app is running" app_running
login
restored_matches_a "$B" "$B_KEY_ID"
expect "RESTORE audit entry {full:true, file, files}" eq "$(audit_count "$B" RESTORE "$BK5")" 1
expect "B's admin, who is not in the backup, is still there" eq "$(sql "$B" "SELECT count(*) FROM \"User\" WHERE username = 'ciadmin';")" 1
if [ -n "$PRE" ]; then
  same_text "$PRE holds B's previous files, byte for byte" "$B_PREVIOUS" \
    "$(sudo bash -c "cd '$B/data/uploads/$PRE' && find images documents -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum")"
fi
sudo ls -la "$B/backups" | sed 's/^/  /'
expect "the snapshot taken before the restore is in backups/ (database 600, uploads copy)" eq \
  "$(sudo find "$B/backups" -maxdepth 1 -name 'blackvault-*.db' -perm 600 | wc -l | tr -d ' ') $(sudo find "$B/backups" -maxdepth 1 -type d -name 'uploads-*' | wc -l | tr -d ' ')" "1 1"
endstep

step "4. on B: a restore that FAILS after its database step is rolled back completely"
failing_restore "$B" "$BK5" 1
endstep

step "8. reencrypt-files.sh: A's raw uploads folder, dropped into B"
INSTANCE=$(app_instance)
wrap "$B" "./reencrypt-files.sh --from-key-file $HOME_DIR/no-such-key"
expect "a missing old key file: exit 3" eq "$RC" 3
expect "the app was never stopped" eq "$(app_instance)" "$INSTANCE"
# The files as they are on A's disk: BVF1 under A's key. The running app only
# looks at the folder when it starts.
sudo rm -rf "$B/data/uploads/images" "$B/data/uploads/documents"
sudo cp -a "$WORK/a-uploads/images" "$WORK/a-uploads/documents" "$B/data/uploads/"
expect "B's uploads are now all under A's key $A_KEY_ID" uploads_under_key "$B" "$A_KEY_ID" "$A_FILES"
wrap "$B" "./reencrypt-files.sh --from-key-file $HOME_DIR/ci-a-key"
expect "exit 0" eq "$RC" 0
expect "the summary line: all $A_FILES re-encrypted" eq "$OUT" "BLACKVAULT_REENCRYPT_OK reencrypted=$A_FILES already_current=0 unknown_key=0 not_encrypted=0 failed=0 stopped=0"
expect "it started BlackVault again (docker compose start after the one-off run)" hasf "$ERR" "BlackVault was started again."
wait_up
STARTED_AT=$(docker inspect -f '{{.State.StartedAt}}' blackvault)
LOGS=$(as_in "$B" "docker compose logs --no-color --since $STARTED_AT blackvault" 2>&1)
if has "$LOGS" "is encrypted with key\|efusing to start"; then bad "the start after the re-encryption complained about the uploads folder"; else ok "the start after it accepted the uploads folder"; fi
expect "every file is now under B's key $B_KEY_ID" uploads_under_key "$B" "$B_KEY_ID" "$A_FILES"
same_text "every file is served by B with its original sha256" "$A_SERVED" "$(served_by_app <<<"$A_URLS")"
wrap "$B" "./reencrypt-files.sh --from-key-file $HOME_DIR/ci-a-key"
expect "a second run exits 3" eq "$RC" 3
expect "and says nothing matched" eq "$OUT" "BLACKVAULT_REENCRYPT_NOTHING reencrypted=0 already_current=$A_FILES unknown_key=0 not_encrypted=0 failed=0 stopped=0"
expect "and started BlackVault again" hasf "$ERR" "Nothing was changed. BlackVault was started again."
wait_up
# Why the tool exists: with ONE file under another key the app refuses to start.
as_in "$B" "docker compose stop blackvault" >/dev/null 2>&1
FOREIGN=$(sudo find "$WORK/a-uploads/documents" -type f | head -n 1)
sudo cp -p "$FOREIGN" "$B/data/uploads/documents/$(basename "$FOREIGN")"
as_in "$B" "docker compose up -d" >/dev/null 2>&1 || true
LOGS=""
for _ in $(seq 1 40); do
  LOGS=$(as_in "$B" "docker compose logs --no-color --since 2m blackvault" 2>&1 || true)
  has "$LOGS" "is encrypted with key $A_KEY_ID, not the current key $B_KEY_ID" && break
  sleep 3
done
grep "is encrypted with key" <<<"$LOGS" | tail -n 1 | cut -c1-300 || true
expect "without the tool, a file under A's key makes B refuse to start" hasf "$LOGS" "is encrypted with key $A_KEY_ID, not the current key $B_KEY_ID"
down
endstep

# ════════════════════════════════════════════════════════════════════════════
step "9a. PostgreSQL: install C (another key); A's backup, made on SQLite, restored onto it"
new_install "$C" postgres
C_KEY_ID=$(key_id_of "$C/secrets/blackvault_encryption_key")
echo "install C key id: $C_KEY_ID"
[ "$C_KEY_ID" != "$A_KEY_ID" ] || fail "C has A's key"
put_backup "$A_BACKUP" "$C"
wrap "$C" "./restore.sh $BK5 --yes --passphrase-file $PASSFILE"
good_restore "$C" "$BK5" "$A_FILES"
wait_up
login
restored_matches_a "$C" "$C_KEY_ID"
expect "RESTORE audit entry" eq "$(audit_count "$C" RESTORE "$BK5")" 1
expect "the snapshot taken before the restore is a pg_dump in backups/ (mode 600)" eq "$(sudo find "$C/backups" -maxdepth 1 -name 'blackvault-*.sql' -perm 600 | wc -l | tr -d ' ')" 1
endstep

step "9b. PostgreSQL: backup.sh on C, app running and app stopped"
sudo rm -f "$C/data/backups/$BK5"
wrap "$C" "./backup.sh --passphrase-file $PASSFILE"
good_backup "$C" "$A_FILES" "$A_BYTES"
as_in "$C" "docker compose stop blackvault" >/dev/null 2>&1 || fail "could not stop C"
sleep 1
wrap "$C" "./backup.sh --passphrase-file $PASSFILE"
good_backup "$C" "$A_FILES" "$A_BYTES"
C_NAME=$NEW
[ -n "$C_NAME" ] || fail "no backup was made on C"
expect "the app is still stopped and the database container is still running" eq \
  "$(docker inspect -f '{{.State.Running}}' blackvault) $(docker inspect -f '{{.State.Running}}' blackvault-db)" "false true"
wrap "$C" "./backup.sh --verify $C_NAME --passphrase-file $PASSFILE"
expect "--verify of the PostgreSQL-made backup: exit 0" eq "$RC" 0
C_BACKUP="$WORK/$C_NAME"
sudo cp "$C/data/backups/$C_NAME" "$C_BACKUP"
down
endstep

step "9c. PostgreSQL: install D (another key); C's backup restored onto it"
new_install "$D" postgres
D_KEY_ID=$(key_id_of "$D/secrets/blackvault_encryption_key")
echo "install D key id: $D_KEY_ID"
[ "$D_KEY_ID" != "$C_KEY_ID" ] || fail "D has C's key"
put_backup "$C_BACKUP" "$D"
wrap "$D" "./restore.sh $C_NAME --yes --passphrase-file $PASSFILE"
good_restore "$D" "$C_NAME" "$A_FILES"
wait_up
login
restored_matches_a "$D" "$D_KEY_ID"
expect "RESTORE audit entry" eq "$(audit_count "$D" RESTORE "$C_NAME")" 1
endstep

step "9d. PostgreSQL: a restore onto D that FAILS after its database step is rolled back (pg_dump → side database → drop/rename)"
failing_restore "$D" "$C_NAME" 1
endstep

# ════════════════════════════════════════════════════════════════════════════
# set_backup_dir PATH: BLACKVAULT_BACKUP_DIR in D's .env, the container recreated.
set_backup_dir() {
  as_in "$D" "sed -i '/^BLACKVAULT_BACKUP_DIR=/d' .env && echo 'BLACKVAULT_BACKUP_DIR=$1' >> .env"
  up
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/backups"}}{{.Source}}{{end}}{{end}}' blackvault)" = "$1" ] ||
    fail "the container's /app/backups is not mounted from $1"
}
# fat_folder NAME MOUNT-OPTIONS → /mnt/NAME, a 64 MB FAT filesystem.
fat_folder() {
  sudo dd if=/dev/zero of="$WORK/$1.img" bs=1M count=64 status=none
  sudo mkfs.vfat "$WORK/$1.img" >/dev/null || fail "mkfs.vfat failed"
  sudo mkdir -p "/mnt/$1"
  sudo mount -o "loop,$2" "$WORK/$1.img" "/mnt/$1" || fail "could not mount the FAT image ($2)"
}
entrypoint_log() { as_in "$D" "docker compose logs --no-color --since $(docker inspect -f '{{.State.StartedAt}}' blackvault) blackvault" 2>&1 | grep '\[entrypoint\]' || true; }
D_FILES=$(urls_of "$D" | wc -l | tr -d ' ')
D_BYTES=$(served_by_app < <(urls_of "$D") | awk '{s += $3} END {print s}')

step "10a. the backup folder on a FAT filesystem that belongs to ANOTHER uid: chown refused, chmod refused, no hard links"
command -v mkfs.vfat >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq dosfstools; }
fat_folder bv-fat-foreign "uid=0,gid=0,umask=000"
set_backup_dir /mnt/bv-fat-foreign
LOGS=$(entrypoint_log)
echo "$LOGS" | cut -c1-400
expect "the entrypoint warns that the owner could not be set and leaves the mode alone" hasf "$LOGS" "[entrypoint] WARNING: could not set the owner of the backup folder /app/backups (a network share usually refuses this), so its mode was left as it is."
expect "and says backups will work, because the app can write there" hasf "$LOGS" "The app can write to it, so full backups will work"
sudo -u '#1001' touch /mnt/bv-fat-foreign/ci-a || bad "uid 1001 cannot write to the FAT folder"
if sudo -u '#1001' ln /mnt/bv-fat-foreign/ci-a /mnt/bv-fat-foreign/ci-b 2>/dev/null; then
  bad "this filesystem has hard links: the case proves nothing about the rename fallback"
else ok "uid 1001 can write there but cannot hard-link (so a backup is published by rename)"; fi
if sudo -u '#1001' chmod 600 /mnt/bv-fat-foreign/ci-a 2>/dev/null; then bad "uid 1001 can chmod there: the case proves nothing about a refused chmod"; else ok "and cannot chmod what it creates"; fi
sudo rm -f /mnt/bv-fat-foreign/ci-a /mnt/bv-fat-foreign/ci-b
wrap "$D" "./backup.sh --passphrase-file $PASSFILE --keep 1"
good_backup "$D" "$D_FILES" "$D_BYTES" /mnt/bv-fat-foreign "0:0 777" "0:0 777"
FAT1=$NEW
expect "it warns that the mode could not be set, and why" hasf "$ERR" "its mode could not be set to 600 (EPERM): the backup folder /app/backups is on a filesystem that does not let the app change it"
sleep 1
wrap "$D" "./backup.sh --passphrase-file $PASSFILE --keep 1"
good_backup "$D" "$D_FILES" "$D_BYTES" /mnt/bv-fat-foreign "0:0 777" "0:0 777"
expect "--keep 1 deleted the first one there" hasf "$ERR" "full-backup: deleted old backup $FAT1"
expect "exactly one backup is left" eq "$(sudo find /mnt/bv-fat-foreign -name 'blackvault-full-*.bvb' | wc -l | tr -d ' ')" 1
wrap "$D" "./backup.sh --verify $NEW --passphrase-file $PASSFILE"
expect "--verify of the backup on FAT: exit 0" eq "$RC" 0
endstep

step "10b. the backup folder on a FAT filesystem mounted for uid 1001 (no hard links, nothing refused)"
fat_folder bv-fat-own "uid=1001,gid=1001,fmask=0177,dmask=0077"
set_backup_dir /mnt/bv-fat-own
LOGS=$(entrypoint_log)
expect "the entrypoint has nothing to warn about" eq "$LOGS" ""
wrap "$D" "./backup.sh --passphrase-file $PASSFILE"
good_backup "$D" "$D_FILES" "$D_BYTES" /mnt/bv-fat-own
if has "$ERR" "WARNING"; then bad "an unexpected WARNING"; else ok "no WARNING"; fi
endstep

step "10c. BLACKVAULT_BACKUP_DIR on a path that is NOT mounted: Docker creates it on the local disk, and the backup lands there without an error"
sudo rm -rf /mnt/bv-nas-not-mounted
set_backup_dir /mnt/bv-nas-not-mounted/blackvault-backups
expect "Docker created the folder, on the local disk, and the entrypoint gave it to uid 1001" eq \
  "$(sudo stat -c '%u:%g %a' /mnt/bv-nas-not-mounted/blackvault-backups) $(sudo stat -f -c '%T' /mnt/bv-nas-not-mounted/blackvault-backups | grep -c 'msdos\|nfs\|cifs\|smb')" "1001:1001 700 0"
wrap "$D" "./backup.sh --passphrase-file $PASSFILE"
good_backup "$D" "$D_FILES" "$D_BYTES" /mnt/bv-nas-not-mounted/blackvault-backups
if has "$ERR" "WARNING\|ERROR"; then bad "it said something about the folder"; else ok "nothing warns that the share is missing (hence the README's note)"; fi
down
sudo umount /mnt/bv-fat-foreign /mnt/bv-fat-own || true
sudo rm -rf /mnt/bv-nas-not-mounted /mnt/bv-fat-foreign /mnt/bv-fat-own
endstep

rm -rf "$WORK" 2>/dev/null || sudo rm -rf "$WORK"
if [ "$FAILED" -ne 0 ]; then
  echo "::error::full backups on real Linux Docker: $FAILED check(s) failed (see the ::error:: lines above)"
  exit 1
fi
echo "full backups verified on real Linux Docker"
