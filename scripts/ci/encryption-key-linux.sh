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
#   5. Uploads are encrypted at rest (spec 3b): a photo and a PDF uploaded
#      through the API are BVF1 on the volume and served back intact with
#      Cache-Control: private, no-store; an upgrade with plaintext uploads and
#      a legacy document rescued by `docker cp` encrypts them, snapshots them
#      (700/600, uid 1001) and writes one FILES_ENCRYPTED event; after
#      rotate-key.sh every file carries the new key id and still serves.
#   6. Photo ingest: `sharp` loads inside the built image and processes a
#      picture; the phone capture page answers a signed-out request with the
#      bare layout and no-referrer / no-store headers, the capture API behaves
#      as specified for a signed-out caller.
set -Eeuo pipefail

# curl's write-out format for the response status.
CURL_CODE='%{http_code}'

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

# ---- encrypted uploads (spec 3b) ----
BASE=http://localhost:3000
UPLOADS="$APP/data/uploads"
WORK=$(mktemp -d)
JAR="$WORK/cookies"
# The uploads volume belongs to uid 1001, so every read of it goes through sudo.
sha_of() { sudo sha256sum "$1" | cut -d' ' -f1; }
magic_of() { sudo head -c4 "$1" | tr -d '\0'; }
# Key id of a BVF1 file: bytes 5-12 of the header (src/lib/encryption/core.mjs fileKeyId).
file_key_id() { sudo dd if="$1" bs=1 skip=5 count=8 status=none; }
files_encrypted_events() {
  sudo sqlite3 "$APP/data/db/vault.db" "SELECT count(*) FROM AuditEvent WHERE action = 'FILES_ENCRYPTED';"
}

# assert_uploads_encrypted COUNT [KEY_ID]: exactly COUNT regular files under the
# uploads volume, each starting with BVF1 (and under KEY_ID when given). The
# app's own .pre-encryption-* snapshot folders hold plaintext by design and
# are skipped.
assert_uploads_encrypted() {
  local want="$1" key="${2:-}" f n=0
  while IFS= read -r -d '' f; do
    [ "$(magic_of "$f")" = "BVF1" ] || fail "not encrypted at rest (no BVF1 header): $f"
    if [ -n "$key" ]; then
      [ "$(file_key_id "$f")" = "$key" ] || fail "$f is under key $(file_key_id "$f"), want $key"
    fi
    n=$((n + 1))
  done < <(sudo find "$UPLOADS" -path "$UPLOADS/.pre-encryption-*" -prune -o -type f -print0)
  [ "$n" = "$want" ] || fail "expected $want files under the uploads volume, found $n"
  echo "$n files under the uploads volume, all BVF1${key:+ under key $key}"
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

# serve_check URL SHA256: an authenticated GET returns 200, the original bytes
# and Cache-Control: private, no-store.
serve_check() {
  local url="$1" want="$2" code cc
  code=$(curl -sS -b "$JAR" -o "$WORK/body" -D "$WORK/headers" -w "$CURL_CODE" "$BASE$url")
  [ "$code" = "200" ] || fail "GET $url: HTTP $code"
  [ "$(sha256sum <"$WORK/body" | cut -d' ' -f1)" = "$want" ] || fail "GET $url: the bytes differ from the original"
  cc=$(grep -i '^cache-control:' "$WORK/headers" | tr -d '\r' | cut -d' ' -f2- || true)
  [ "$cc" = "private, no-store" ] || fail "GET $url: Cache-Control is '$cc', want 'private, no-store'"
  echo "GET $url: 200, original sha256, Cache-Control: $cc"
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

step "2b. first admin, with the setup token from the log"
LOGS=$(as_user "docker compose logs --no-color blackvault")
# A new token at every start while no admin exists: only the last one is valid.
TOKEN=$(grep -o 'Setup token: [A-Z0-9-]*' <<<"$LOGS" | tail -1 | cut -d' ' -f3 || true)
[ -n "$TOKEN" ] || fail "no setup token in the log"
CODE=$(curl -sS -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' -H "Origin: $BASE" \
  -d "$(jq -n --arg c "$TOKEN" '{setupCode: $c, username: "ciadmin", displayName: "CI Admin", password: "ci-admin-password-1234"}')" \
  -o "$WORK/setup.json" -w "$CURL_CODE" "$BASE/api/auth/setup")
[ "$CODE" = "201" ] || fail "setup: HTTP $CODE $(cat "$WORK/setup.json")"
[ "$(jq -r .user.role "$WORK/setup.json")" = "ADMIN" ] || fail "setup did not create an admin: $(cat "$WORK/setup.json")"
echo "signed in as ciadmin (ADMIN)"
endstep

step "2c. a photo and a PDF uploaded through the API are encrypted at rest"
# Pictures are decoded and re-saved on upload (src/lib/images/process.ts), so the picture must be a real
# PNG, and its reference checksum is that of the bytes the app stored (what it serves right after).
# PDFs are stored as uploaded: the route checks only the leading magic bytes.
make_png "$WORK/upload.png" 4000
{ printf '%%PDF-1.4\n'; head -c 4000 /dev/urandom; } >"$WORK/upload.pdf"
UP_PDF_SHA=$(sha256sum <"$WORK/upload.pdf" | cut -d' ' -f1)
CODE=$(curl -sS -b "$JAR" -H "Origin: $BASE" -F "file=@$WORK/upload.png;type=image/png" \
  -F entityType=firearm -F entityId=ci-f1 -o "$WORK/img.json" -w "$CURL_CODE" "$BASE/api/images/upload")
[ "$CODE" = "201" ] || fail "image upload: HTTP $CODE $(cat "$WORK/img.json")"
UP_IMG_URL=$(jq -r .url "$WORK/img.json")
CODE=$(curl -sS -b "$JAR" -o "$WORK/stored.png" -w "$CURL_CODE" "$BASE$UP_IMG_URL")
[[ "$CODE" = "200" ]] || fail "GET $UP_IMG_URL right after the upload: HTTP $CODE"
[[ "$(head -c8 "$WORK/stored.png" | xxd -p)" = "89504e470d0a1a0a" ]] || fail "the stored picture is not a PNG"
UP_IMG_SHA=$(sha256sum <"$WORK/stored.png" | cut -d' ' -f1)
CODE=$(curl -sS -b "$JAR" -H "Origin: $BASE" -F "file=@$WORK/upload.pdf;type=application/pdf" \
  -F "name=CI Upload PDF" -F firearmId=ci-f1 -o "$WORK/doc.json" -w "$CURL_CODE" "$BASE/api/documents/upload")
[ "$CODE" = "201" ] || fail "document upload: HTTP $CODE $(cat "$WORK/doc.json")"
UP_PDF_URL=$(jq -r .fileUrl "$WORK/doc.json")
echo "uploaded $UP_IMG_URL and $UP_PDF_URL"
UP_IMG_FILE="$APP/data$UP_IMG_URL"
UP_PDF_FILE="$UPLOADS/documents/$(basename "$UP_PDF_URL")"
for f in "$UP_IMG_FILE" "$UP_PDF_FILE"; do
  sudo test -f "$f" || fail "uploaded file not on the volume: $f"
done
assert_uploads_encrypted 2 "$OLD_ID"
serve_check "$UP_IMG_URL" "$UP_IMG_SHA"
serve_check "$UP_PDF_URL" "$UP_PDF_SHA"
[ "$(files_encrypted_events)" = "0" ] || fail "uploads wrote a FILES_ENCRYPTED event"
endstep

step "2d. upgrade: plaintext uploads from before file encryption, legacy document rescued with docker cp"
# Seeded straight into the volume and into the old in-container documents
# folder of this branch's image, rather than produced by a pre-3b release.
as_user "docker compose stop"
SEED_IMG="ci-f1_1700000000000.png"
SEED_DOC="0123456789abcdef0123456789abcdef.pdf"
{ printf '\x89PNG\r\n\x1a\n'; head -c 4000 /dev/urandom; } >"$WORK/seed.png"
{ printf '%%PDF-1.4\n'; head -c 4000 /dev/urandom; } >"$WORK/seed.pdf"
SEED_IMG_SHA=$(sha256sum <"$WORK/seed.png" | cut -d' ' -f1)
SEED_PDF_SHA=$(sha256sum <"$WORK/seed.pdf" | cut -d' ' -f1)
sudo install -o 1001 -g 1001 -m 644 "$WORK/seed.png" "$UPLOADS/images/firearms/$SEED_IMG"
# /app/storage/uploads/documents, the pre-3b location (src/lib/files/storage.ts legacyDocumentsRoot).
mkdir -p "$WORK/legacy/storage/uploads/documents"
cp "$WORK/seed.pdf" "$WORK/legacy/storage/uploads/documents/$SEED_DOC"
tar -C "$WORK/legacy" --owner=1001 --group=1001 -cf - storage | docker cp - blackvault:/app
sudo sqlite3 "$APP/data/db/vault.db" "INSERT INTO Document (id, name, type, fileUrl, fileSize, mimeType, firearmId, updatedAt)
  VALUES ('ci-doc-legacy', 'CI Legacy Receipt', 'RECEIPT', '/api/files/documents/$SEED_DOC', $(stat -c %s "$WORK/seed.pdf"), 'application/pdf', 'ci-f1', 1700000000000);"
# The rescue step, run before upgrading.
sudo docker cp blackvault:/app/storage/uploads/documents "$UPLOADS/"
echo "after docker cp: $(sudo stat -c '%n %U:%G %a' "$UPLOADS/documents" "$UPLOADS/documents/$SEED_DOC" | tr '\n' ' ')"
# docker cp gives the copies to the user who ran it; the app (uid 1001) must own them.
# The README's Linux rescue (final review FIX 2) gives it the whole uploads folder.
sudo chown -R 1001:1001 "$UPLOADS"
[ "$(sha_of "$UPLOADS/documents/$SEED_DOC")" = "$SEED_PDF_SHA" ] || fail "the rescued document differs from the seed"
as_user "docker compose up -d"
wait_healthy
LOGS=$(as_user "docker compose logs --no-color --since 3m blackvault")
echo "$LOGS" | grep '\[files\]' || true
has "$LOGS" "Encrypted existing uploads: 1 photos, 1 documents" || fail "startup did not encrypt the seeded photo and document"
assert_uploads_encrypted 4 "$OLD_ID"
serve_check "/uploads/images/firearms/$SEED_IMG" "$SEED_IMG_SHA"
serve_check "/api/files/documents/$SEED_DOC" "$SEED_PDF_SHA"
mapfile -t USNAPS < <(sudo find "$UPLOADS" -maxdepth 1 -name '.pre-encryption-*' -printf '%f\n')
echo "uploads snapshots: ${USNAPS[*]:-<none>}"
[ "${#USNAPS[@]}" = "1" ] || fail "expected one .pre-encryption-* snapshot (and no .partial), found ${#USNAPS[@]}"
[[ "${USNAPS[0]}" =~ ^\.pre-encryption-[0-9]{8}-[0-9]{6}(-[0-9]+)?$ ]] || fail "unexpected snapshot name ${USNAPS[0]}"
USNAP="$UPLOADS/${USNAPS[0]}"
[ "$(sudo stat -c '%a %u' "$USNAP")" = "700 1001" ] || fail "snapshot folder is $(sudo stat -c '%a %u' "$USNAP"), want 700 1001"
mapfile -t SNAP_FILES < <(sudo find "$USNAP" -type f)
[ "${#SNAP_FILES[@]}" = "2" ] || fail "snapshot holds ${#SNAP_FILES[@]} files, want 2: ${SNAP_FILES[*]}"
for f in "${SNAP_FILES[@]}"; do
  [ "$(sudo stat -c '%a %u' "$f")" = "600 1001" ] || fail "$f is $(sudo stat -c '%a %u' "$f"), want 600 1001"
done
SNAP_SHAS=$(for f in "${SNAP_FILES[@]}"; do sha_of "$f"; done)
has "$SNAP_SHAS" "$SEED_IMG_SHA" || fail "the snapshot does not hold the original photo"
has "$SNAP_SHAS" "$SEED_PDF_SHA" || fail "the snapshot does not hold the original document"
[ "$(files_encrypted_events)" = "1" ] || fail "expected exactly one FILES_ENCRYPTED event, found $(files_encrypted_events)"
echo "upgrade: seeds encrypted, served intact; snapshot ${USNAPS[0]} (700, files 600, uid 1001, plaintext); one FILES_ENCRYPTED"
endstep

step "2e. photo ingest: sharp in the image, the capture routes on a real server"
# The image must carry sharp's native files (the standalone output copies only what it traces).
# It encodes a generated JPEG, then decodes it again and writes a WebP, the paths the app takes.
SHARP_JS="const s=require('sharp');s({create:{width:8,height:8,channels:3,background:'#fff'}}).jpeg().toBuffer().then(b=>{if(b.length<100)process.exit(1);return s(b).rotate().webp().toBuffer()}).then(w=>{if(w.length<10||w.subarray(8,12).toString()!=='WEBP')process.exit(1);console.log('sharp ok')})"
SHARP_OUT=$(timeout 120 docker exec blackvault node -e "$SHARP_JS" 2>&1) || fail "sharp does not run inside the image: $SHARP_OUT"
[[ "$SHARP_OUT" = "sharp ok" ]] || fail "sharp printed '$SHARP_OUT', want 'sharp ok'"
echo "$SHARP_OUT"
# A well-formed token that belongs to no pass: the page itself is public and bare.
CAP_TOKEN=$(printf 'A%.0s' $(seq 1 43))
CODE=$(curl -sS -o "$WORK/capture.html" -D "$WORK/capture.headers" -w "$CURL_CODE" "$BASE/capture/$CAP_TOKEN")
[[ "$CODE" = "200" ]] || fail "signed-out GET /capture/<token>: HTTP $CODE"
RP=$(grep -i '^referrer-policy:' "$WORK/capture.headers" | tr -d '\r' | cut -d' ' -f2- || true)
[[ "$RP" = "no-referrer" ]] || fail "/capture/<token>: Referrer-Policy is '$RP', want 'no-referrer'"
CC=$(grep -i '^cache-control:' "$WORK/capture.headers" | tr -d '\r' | cut -d' ' -f2- || true)
case "$CC" in *no-store*) ;; *) fail "/capture/<token>: Cache-Control is '$CC', want it to contain no-store" ;; esac
# The signed-in layout always renders the mobile navigation drawer; the bare capture layout must not.
# The same marker in a signed-in page proves the check can fail.
CHROME_MARK='id="mobile-navigation"'
curl -sS -b "$JAR" -o "$WORK/home.html" "$BASE/"
grep -q -- "$CHROME_MARK" "$WORK/home.html" || fail "the signed-in page lacks $CHROME_MARK: the chrome check below would prove nothing"
grep -q -- "$CHROME_MARK" "$WORK/capture.html" && fail "/capture/<token> renders the app chrome ($CHROME_MARK)"
echo "GET /capture/<token>: 200, Referrer-Policy: $RP, Cache-Control: $CC, no app chrome"
CODE=$(curl -sS -o "$WORK/passes.json" -w "$CURL_CODE" "$BASE/api/capture-passes/x")
[[ "$CODE" = "401" ]] || fail "signed-out GET /api/capture-passes/x: HTTP $CODE, want 401"
CODE=$(curl -sS -o "$WORK/capture.json" -D "$WORK/capture-api.headers" -w "$CURL_CODE" "$BASE/api/capture/$CAP_TOKEN")
[[ "$CODE" = "404" ]] || fail "GET /api/capture/<token>: HTTP $CODE, want 404"
jq -e . "$WORK/capture.json" >/dev/null || fail "GET /api/capture/<token>: the 404 body is not JSON: $(cat "$WORK/capture.json")"
has "$(grep -i '^content-type:' "$WORK/capture-api.headers")" "application/json" || fail "GET /api/capture/<token>: Content-Type is not JSON"
echo "signed-out: /api/capture-passes/x 401, /api/capture/<token> 404 JSON"
endstep

step "3. rotate-key.sh end to end (SQLite)"
# Final review FIX 3: a checkout made under umask 077 leaves the mounted
# snapshot script 0600, owned by the host user, so uid 1001 cannot open it.
# The in-container uploads copy below must still work: only root reads it.
as_user "chmod 600 scripts/uploads-snapshot.sh"
[ "$(sudo stat -c '%a %u' "$APP/scripts/uploads-snapshot.sh")" = "600 $TEST_UID" ] ||
  fail "scripts/uploads-snapshot.sh is $(sudo stat -c '%a %u' "$APP/scripts/uploads-snapshot.sh"), want 600 $TEST_UID"
if ! OUT=$(as_user "./rotate-key.sh" </dev/null 2>&1); then
  echo "$OUT" | tail -40
  fail "rotate-key.sh failed"
fi
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

step "3b. uploads after the rotation: under the new key, still served intact"
assert_uploads_encrypted 4 "$NEW_ID"
serve_check "$UP_IMG_URL" "$UP_IMG_SHA"
serve_check "$UP_PDF_URL" "$UP_PDF_SHA"
serve_check "/uploads/images/firearms/$SEED_IMG" "$SEED_IMG_SHA"
serve_check "/api/files/documents/$SEED_DOC" "$SEED_PDF_SHA"
[ "$(files_encrypted_events)" = "1" ] || fail "after the rotation: $(files_encrypted_events) FILES_ENCRYPTED events, want 1"
# rotate-key.sh's db-snapshot.sh copied the uploads inside a uid-1001
# container: 4 BVF1 files (old key), no .pre-encryption-* folder, 700/600, uid 1001.
mapfile -t BUPS < <(sudo find "$APP/backups" -maxdepth 1 -name 'uploads-*' -printf '%f\n')
[ "${#BUPS[@]}" = "1" ] || fail "expected one backups/uploads-* snapshot (and no .partial), found: ${BUPS[*]:-none}"
BUP="$APP/backups/${BUPS[0]}"
[ "$(sudo stat -c '%a %u' "$BUP")" = "700 1001" ] || fail "$BUP is $(sudo stat -c '%a %u' "$BUP"), want 700 1001"
[ -z "$(sudo find "$BUP" -name '.pre-encryption-*')" ] || fail "the uploads snapshot copied a .pre-encryption-* folder"
n=0
while IFS= read -r -d '' f; do
  [ "$(sudo stat -c '%a %u' "$f")" = "600 1001" ] || fail "$f is $(sudo stat -c '%a %u' "$f"), want 600 1001"
  [ "$(magic_of "$f")" = "BVF1" ] || fail "$f in the uploads snapshot is not BVF1"
  [ "$(file_key_id "$f")" = "$OLD_ID" ] || fail "$f in the uploads snapshot is not under the pre-rotation key $OLD_ID"
  n=$((n + 1))
done < <(sudo find "$BUP" -type f -print0)
[ "$n" = "4" ] || fail "the uploads snapshot holds $n files, want 4"
while IFS= read -r -d '' d; do
  [ "$(sudo stat -c '%a %u' "$d")" = "700 1001" ] || fail "$d is $(sudo stat -c '%a %u' "$d"), want 700 1001"
done < <(sudo find "$BUP" -type d -print0)
echo "pre-rotation uploads snapshot ${BUPS[0]}: 4 BVF1 files under $OLD_ID, 700/600, uid 1001"
echo "every upload re-encrypted under $NEW_ID and served with its original bytes"
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
