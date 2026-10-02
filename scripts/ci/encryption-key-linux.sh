#!/bin/bash
# Field-encryption key handling on REAL Linux Docker (Task 7, carry I3).
# Run by the `encryption-key-linux` job in .github/workflows/ci.yml on
# ubuntu-latest, from the repository root, as a user with passwordless sudo.
#
# What it proves, none of which Docker Desktop (macOS/Windows) can show:
#   1. With NO key file, the stack still starts (docker-compose.yml mounts the
#      always-present secrets/ folder) and the app refuses with KEY_MISSING
#      naming where the key goes — the first upgrade run by the OLD update.sh.
#   2. install.sh, run by a non-root host user whose uid is NOT 1001, creates
#      secrets/blackvault_encryption_key mode 600 owned by that user, and the
#      app (uid 1001 in the container) starts with it: the entrypoint's copy.
#      (The runner's own user IS uid 1001, which would hide the problem, so a
#      separate user with uid 1234 does everything.)
#   3. rotate-key.sh rotates end to end against SQLite (snapshot, `compose run`
#      of the rotation, key swap), and the app restarts on the NEW key.
#   4. Afterwards the key file is still mode 600 and owned by that user, and
#      no other host user can read it.
set -Eeuo pipefail

TEST_USER=bvtest
TEST_UID=1234
APP=/home/$TEST_USER/app

step() { echo; echo "::group::$*"; }
endstep() { echo "::endgroup::"; }
fail() { echo "::error::$*"; exit 1; }
as_user() { sudo -u "$TEST_USER" -H bash -c "cd '$APP' && $*"; }
# has TEXT PATTERN: grep -q on a here-string. Never `cmd | grep -q`: under
# pipefail an early grep exit can SIGPIPE the writer and fail the pipeline.
has() { grep -q -- "$2" <<<"$1"; }

# Asserts /run/secrets inside container $1 (or, with $1 = "-", the /proc/mounts
# text in $2) is its own tmpfs mounted nosuid,nodev,noexec, and prints it.
assert_secrets_tmpfs() {
  local mounts="$2" line opts o
  line=$(awk '$2 == "/run/secrets"' <<<"$mounts")
  echo "/run/secrets mount ($1): ${line:-<none>}"
  [ -n "$line" ] || fail "$1: /run/secrets is not a separate mount"
  [ "$(awk '{print $3}' <<<"$line")" = "tmpfs" ] || fail "$1: /run/secrets is not a tmpfs ($line)"
  opts=",$(awk '{print $4}' <<<"$line"),"
  for o in nosuid nodev noexec; do
    case "$opts" in *",$o,"*) ;; *) fail "$1: /run/secrets tmpfs lacks $o ($line)" ;; esac
  done
}

dump_logs() {
  echo "::group::container logs (on failure)"
  as_user "docker compose logs --no-color --tail 200" || true
  echo "::endgroup::"
}
trap 'dump_logs' ERR

# Waits until the blackvault container reports healthy (or fails after ~4 min).
wait_healthy() {
  local status=""
  for _ in $(seq 1 80); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' blackvault 2>/dev/null || true)
    [ "$status" = "healthy" ] && return 0
    sleep 3
  done
  fail "blackvault never became healthy (last status: ${status:-none})"
}

# Key id of a 64-hex key file: first 8 hex of SHA-256 of the raw 32 bytes
# (src/lib/encryption/core.mjs keyId).
key_id_of() { sudo cat "$1" | tr -d '[:space:]' | xxd -r -p | sha256sum | cut -c1-8; }

# Key id the database's key check was written with (bv2:<keyId>:...).
db_key_id() {
  sudo sqlite3 "$APP/data/db/vault.db" "SELECT encryptionKeyCheck FROM AppSettings WHERE id='singleton';" | cut -d: -f2
}

step "tools"
if ! command -v sqlite3 >/dev/null || ! command -v xxd >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq sqlite3 xxd
fi
endstep

step "test user (uid $TEST_UID, not 1001) and a copy of the repo it owns"
sudo useradd --create-home --uid "$TEST_UID" --shell /bin/bash "$TEST_USER"
sudo usermod -aG docker "$TEST_USER"
sudo cp -a "$PWD" "$APP"
sudo chown -R "$TEST_USER:$TEST_USER" "$APP"
sudo rm -rf "$APP/secrets/blackvault_encryption_key"* "$APP/backups" "$APP/data" "$APP/.env"
# README "Linux only": the data folders belong to the container user.
sudo install -d -o 1001 -g 1001 "$APP/data/db" "$APP/data/uploads"
sudo chown "$TEST_USER:$TEST_USER" "$APP/data"
as_user "umask 077 && cat > .env" <<EOF
DATA_DIR=$APP/data
PORT=3000
BLACKVAULT_DB_PROVIDER=sqlite
BLACKVAULT_PUBLIC_URL=http://localhost:3000
BLACKVAULT_TRUSTED_PROXIES=
BLACKVAULT_DIRECT_ACCESS_INITIAL=on
BLACKVAULT_ALLOW_DIRECT_ACCESS=true
EOF
id "$TEST_USER"
endstep

step "docker compose config renders the key mount and the tmpfs"
CONFIG=$(as_user "docker compose config")
echo "$CONFIG" | grep -A6 "target: /run/blackvault-secrets"
has "$CONFIG" "source: $APP/secrets" || fail "compose config: secrets/ bind source missing"
has "$CONFIG" "target: /run/blackvault-secrets" || fail "compose config: mount target missing"
has "$CONFIG" "/run/secrets:rw,noexec,nosuid,nodev" || fail "compose config: /run/secrets tmpfs (noexec,nosuid,nodev) missing"
endstep

step "build the image"
as_user "docker compose build"
endstep

step "1. no key file: the container is created and the app refuses with KEY_MISSING + where the key goes"
[ -d "$APP/secrets" ] || fail "secrets/ should exist from git (secrets/.gitignore)"
as_user "docker compose up -d"
LOGS=""
for _ in $(seq 1 40); do
  LOGS=$(as_user "docker compose logs --no-color blackvault" 2>&1 || true)
  has "$LOGS" "\[encryption\] No encryption key" && break
  sleep 3
done
echo "$LOGS" | grep "\[encryption\]" || true
has "$LOGS" "Looked for the file /run/secrets/blackvault_encryption_key" || fail "no KEY_MISSING line naming /run/secrets/blackvault_encryption_key"
has "$LOGS" "secrets/blackvault_encryption_key next to docker-compose.yml" || fail "KEY_MISSING does not say where the key goes on the host"
as_user "docker compose stop"
endstep

step "1b. seed plaintext rows, as a release before field encryption stored them"
# The schema exists: the refused start above ran `prisma migrate deploy` first.
# Written as root into the 1001-owned file; SQLite keeps the owner, and the
# rollback journal is gone after the commit.
sudo sqlite3 "$APP/data/db/vault.db" ".read scripts/ci/encryption-seed.sql"
[ "$(sudo stat -c '%u' "$APP/data/db/vault.db")" = "1001" ] || fail "vault.db is no longer owned by 1001"
SEEDED=$(sudo sqlite3 "$APP/data/db/vault.db" "SELECT (SELECT count(*) FROM Firearm) || ' ' || (SELECT count(*) FROM Accessory) || ' ' || (SELECT count(*) FROM Gear) || ' ' || (SELECT serialNumber FROM Firearm WHERE id = 'ci-f1');")
[ "$SEEDED" = "3 2 2 CI-SERIAL-F1" ] || fail "seed: got '$SEEDED'"
echo "seeded plaintext: Firearm 3, Accessory 2, Gear 2"
endstep

step "2. install.sh (existing-install path) creates the key as $TEST_USER; the app starts with it"
OUT=$(as_user "./install.sh" </dev/null)
echo "$OUT" | tail -20
has "$OUT" "BACK THIS FILE UP. Without it your serial numbers and NFA records cannot be recovered." || fail "no back-up message"
KEY="$APP/secrets/blackvault_encryption_key"
[ "$(sudo stat -c '%a %U' "$KEY")" = "600 $TEST_USER" ] || fail "key file is $(sudo stat -c '%a %U' "$KEY"), want 600 $TEST_USER"
[ "$(sudo stat -c '%a %U' "$APP/secrets")" = "700 $TEST_USER" ] || fail "secrets/ is $(sudo stat -c '%a %U' "$APP/secrets"), want 700 $TEST_USER"
# The container user cannot read the host file directly — the very problem.
# If it could, this job would prove nothing about the entrypoint: fail.
if docker run --rm --user 1001:1001 -v "$APP/secrets:/k:ro" alpine:3 cat /k/blackvault_encryption_key >/dev/null 2>&1; then
  fail "uid 1001 could read the mode-600 host key file directly; the I3 premise does not hold, so this run proves nothing"
fi
echo "confirmed: uid 1001 cannot read the mode-600 host key file directly"
wait_healthy
LOGS=$(as_user "docker compose logs --no-color blackvault")
has "$LOGS" "Refusing to start\|refusing to start" && fail "the app refused to start with the key"
# Inside: the app user reads the tmpfs copy; older keys are never copied.
docker exec -u nextjs blackvault sh -c 'test -r /run/secrets/blackvault_encryption_key' || fail "nextjs cannot read /run/secrets/blackvault_encryption_key"
[ "$(docker exec blackvault stat -c '%a %U' /run/secrets/blackvault_encryption_key)" = "400 nextjs" ] || fail "in-container copy is not 400 nextjs"
echo "docker inspect: $(docker inspect -f '{{json .HostConfig.Tmpfs}} {{json .Mounts}}' blackvault)"
MOUNTS=$(docker exec blackvault cat /proc/mounts)
echo "$MOUNTS"
assert_secrets_tmpfs "app container" "$MOUNTS"
PS=$(docker exec blackvault ps -o user,args)
echo "$PS"
# Next renames its process ("next-server (v16…)"); the server must be nextjs,
# and nothing but this `ps` (started as root by docker exec) may be root.
has "$PS" "^nextjs .*next-server" || fail "the app server is not running as nextjs"
ROOT_PROCS=$(awk 'NR > 1 && $1 != "nextjs" && $0 !~ /ps -o user,args/' <<<"$PS")
[ -z "$ROOT_PROCS" ] || fail "processes not running as nextjs: $ROOT_PROCS"
# `docker compose run` (what the rotation uses) gets the same tmpfs and copy.
RUN_OUT=$(as_user "docker compose run --rm -T blackvault sh -c 'cat /proc/mounts; echo COPY=\$(stat -c \"%a %U\" /run/secrets/blackvault_encryption_key)'")
assert_secrets_tmpfs "compose run container" "$RUN_OUT"
has "$RUN_OUT" "COPY=400 nextjs" || fail "compose run: no 400 nextjs key copy ($(grep COPY= <<<"$RUN_OUT"))"
OLD_ID=$(key_id_of "$KEY")
[ "$(db_key_id)" = "$OLD_ID" ] || fail "key check id $(db_key_id) != key file id $OLD_ID"
echo "app started; key check id $OLD_ID"
# The first start encrypted the seeded rows, after its own snapshot.
has "$LOGS" "Encrypted existing data: Firearm 3, Accessory 2, Gear 2" || fail "startup did not encrypt the seeded rows"
has "$LOGS" "Snapshot taken before encrypting existing data: $APP/data/db/pre-encryption-" || fail "no snapshot log line with the HOST path"
mapfile -t SNAPS < <(sudo find "$APP/data/db" -maxdepth 1 -name 'pre-encryption-*' -printf '%f\n')
echo "app snapshots: ${SNAPS[*]:-<none>}"
[ "${#SNAPS[@]}" = "1" ] || fail "expected one pre-encryption snapshot (and no .partial), found ${#SNAPS[@]}"
[[ "${SNAPS[0]}" =~ ^pre-encryption-[0-9]{8}-[0-9]{6}\.db$ ]] || fail "unexpected snapshot name ${SNAPS[0]}"
SNAP="$APP/data/db/${SNAPS[0]}"
[ "$(sudo stat -c '%a %u' "$SNAP")" = "600 1001" ] || fail "app snapshot is $(sudo stat -c '%a %u' "$SNAP"), want 600 1001"
[ "$(sudo sqlite3 "$SNAP" "SELECT serialNumber FROM Firearm WHERE id = 'ci-f1';")" = "CI-SERIAL-F1" ] || fail "the app snapshot does not hold the plaintext serial"
for t in Firearm Accessory Gear; do
  n=$(sudo sqlite3 "$APP/data/db/vault.db" "SELECT count(*) FROM $t WHERE serialNumber IS NOT NULL AND serialNumber NOT LIKE 'bv2:$OLD_ID:%';")
  [ "$n" = "0" ] || fail "$n $t serial(s) not encrypted under $OLD_ID"
done
echo "pre-encryption snapshot ${SNAPS[0]} (600, uid 1001, plaintext); every serial now bv2:$OLD_ID"
endstep

step "3. rotate-key.sh end to end (SQLite)"
OUT=$(as_user "./rotate-key.sh" </dev/null)
echo "$OUT" | tail -30
has "$OUT" "Key rotation complete" || fail "rotation did not complete"
has "$OUT" "(Firearm 3, Accessory 2, Gear 2)" || fail "rotation did not re-encrypt the seeded rows"
sudo ls -la "$APP/secrets" "$APP/backups"
BACKUPS=$(sudo find "$APP/backups" -maxdepth 1 -type f -printf '%f\n')
has "$BACKUPS" '^blackvault-[0-9]\{8\}-[0-9]\{6\}\.db$' || fail "no pre-rotation snapshot in backups/ (have: $BACKUPS)"
OLD_FILES=$(sudo find "$APP/secrets" -name 'blackvault_encryption_key.old-*' | wc -l)
[ "$OLD_FILES" = "1" ] || fail "expected one .old-<ts> key, found $OLD_FILES"
[ "$(key_id_of "$(sudo find "$APP/secrets" -name 'blackvault_encryption_key.old-*')")" = "$OLD_ID" ] || fail ".old-<ts> does not hold the original key"
NEW_ID=$(key_id_of "$KEY")
[ "$NEW_ID" != "$OLD_ID" ] || fail "the key file did not change"
wait_healthy
[ "$(db_key_id)" = "$NEW_ID" ] || fail "after rotation the key check id is $(db_key_id), want $NEW_ID"
for t in Firearm Accessory Gear; do
  n=$(sudo sqlite3 "$APP/data/db/vault.db" "SELECT count(*) FROM $t WHERE serialNumber LIKE 'bv2:$NEW_ID:%';")
  want=$([ "$t" = Firearm ] && echo 3 || echo 2)
  [ "$n" = "$want" ] || fail "$t: $n serial(s) under the new key $NEW_ID, want $want"
done
LOGS=$(as_user "docker compose logs --no-color --since 2m blackvault")
has "$LOGS" "Refusing to start\|refusing to start" && fail "the app refused to start on the new key"
echo "rotated $OLD_ID -> $NEW_ID; app healthy on the new key"
endstep

step "4. host mode and owner of the key afterwards"
for f in "$KEY" $(sudo find "$APP/secrets" -name 'blackvault_encryption_key.old-*'); do
  [ "$(sudo stat -c '%a %U' "$f")" = "600 $TEST_USER" ] || fail "$f is $(sudo stat -c '%a %U' "$f"), want 600 $TEST_USER"
done
[ "$(sudo stat -c '%a %U' "$APP/secrets")" = "700 $TEST_USER" ] || fail "secrets/ changed mode/owner"
# Another host user cannot read it.
sudo useradd --no-create-home --uid 1235 bvother
if sudo -u bvother cat "$KEY" >/dev/null 2>&1; then fail "another host user can read the key"; fi
for f in $(sudo find "$APP/backups" -type f); do
  [ "$(sudo stat -c '%a' "$f")" = "600" ] || fail "$f is not mode 600"
done
[ "$(sudo stat -c '%a %U' "$APP/backups")" = "700 $TEST_USER" ] || fail "backups/ is not 700 $TEST_USER"
echo "key 600 $TEST_USER, secrets/ 700, snapshots 600, unreadable by other users"
endstep

step "5. the entrypoint refuses a key file that is a symlink (M9)"
as_user "ln -s /etc/shadow secrets/blackvault_encryption_key.new"
if SYM_OUT=$(as_user "docker compose run --rm -T blackvault true" 2>&1); then
  fail "compose run started with a symlinked .new key: $SYM_OUT"
fi
echo "$SYM_OUT" | tail -3
has "$SYM_OUT" "blackvault_encryption_key.new is a symbolic link" || fail "no symlink refusal message"
as_user "rm secrets/blackvault_encryption_key.new"
endstep

as_user "docker compose down" || true
echo "encryption key handling verified on real Linux Docker"
