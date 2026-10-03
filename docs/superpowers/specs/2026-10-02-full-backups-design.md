# Full backups with files, and re-encrypting copied files (spec 3c of the auth epic)

- **Status:** approved in conversation on 2026-10-02; the written spec is awaiting review.
- **Builds on:**
  - 3a, field encryption (`ebdbf36`): sealed backups, `core.mjs`, the 64 MB body cap.
  - 3b, encrypted files (`d997e1d`): BVF1 files, `storage.ts`, the rotation file code, the uid-1001 container rules.

## Goal

A single backup file plus its passphrase can rebuild a whole install: database records, photos and documents. It can do so on a machine with a **different** encryption key. A separate command recovers a plain copy of an uploads folder whose files are under an old key, as long as that key is available.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Full backups are written by the server into a backup folder. The user copies them off-site. Expected size is 5–10 GB. | user |
| D2 | Full backups start from a Settings button **and** from `./backup.sh` / `backup.bat` (for cron). Both produce the same archive. No passphrase is ever stored on the server. | user (D) |
| D3 | Files inside the archive are **decrypted** and then sealed with the backup passphrase. The backup does not depend on the server key. | user (A) |
| D4 | Full restore runs only from `./restore.sh` / `restore.bat`, with the app stopped. The browser restore stays for the existing small backups that hold database records only. | user (B) |
| D5 | `./backup.sh --keep N` (default 7) deletes the oldest full backups, but only after the new one has passed verification. The button never deletes anything. | user (B) |
| D6 | Keep `./reencrypt-files.sh --from-key-file <old key>`. | assumed; the user did not object |

## 1. Archive format (`BVB1`)

**File name:** `blackvault-full-<YYYYmmdd-HHMMSS>.bvb`, mode 600, saved in the backup folder (§2).

**Header** (JSON, length-prefixed):

| Field | Value |
|---|---|
| `format` | `"blackvault-full-backup"` |
| `version` | `1` |
| `kdf` | `{ name: "scrypt", N: 65536, r: 8, p: 1, salt: <16 bytes b64url> }`. These are exactly 3a's parameters. Any other values are rejected **before** key derivation. |
| `cipher` | `"aes-256-gcm-stream"` |
| `noncePrefix` | 8 random bytes |
| `chunkSize` | `1048576` |

**Body:** a sequence of chunks, each `ciphertext ‖ 16-byte tag`.
- **Nonce:** `noncePrefix (8 bytes) ‖ uint32be(counter)`, with the counter starting at 0.
- **AAD:** the canonical header JSON, then `uint32be(counter)`, then one final-flag byte (`0x01` on the last chunk, `0x00` otherwise).
- **Verification:** a reader rejects reordered, duplicated or dropped chunks, a body with no final chunk, and any bytes after the final chunk.

**Plaintext stream:** a POSIX ustar tar containing, in this order:
1. `manifest.json`: `{ formatVersion, appVersion, createdAt, keyIdAtBackup, counts (per model), files: [{ path, size, sha256 }], skipped: [{ path, reason }] }`.
2. `db.json`: the same records today's backup holds, with encrypted fields decrypted.
3. `files/images/...` and `files/documents/...`: decrypted file contents. Excluded:
   - `.pre-encryption-*` directories;
   - `*.tmp` and `*.rot` files;
   - hidden entries;
   - symlinks, which are never followed.

**Code location:** all crypto lives in `core.mjs`, with types in `core.d.mts`, as streaming functions:
- `createBackupSealer(passphrase) → Transform` (it writes the header)
- `createBackupOpener(passphrase) → Transform` (it reads and validates the header)

Passphrases are NFC-normalized and must be at least 12 code points long, as in 3a.

## 2. Making a full backup

**Folder:** compose mounts `${BLACKVAULT_BACKUP_DIR:-./data/backups}` at `/app/backups`. The container entrypoint, while it is still running as root, creates `/app/backups` if needed, chowns it to `1001:1001` and sets mode 0700. The small backups' `backupDestinationPath` setting is unchanged.

**Engine:** `scripts/full-backup.mjs`. It runs inside the app container as uid 1001 and is the only code path that creates full backups.
1. Take a lock. If `/app/backups/.full-backup.lock` already exists, exit 2. The lock holds the PID and a start time; a stale lock (dead PID) is reclaimed.
2. Read every backup model, as `/api/backup` does today. Values come back decrypted through the app client.
3. List the files on disk under `uploadsRoot()`.
4. Stream `manifest.json`, then `db.json`, then each decrypted file, through the sealer into `<name>.partial`. Create that file empty, chmod it 0600, then write. A file that vanishes during the run goes into `manifest.skipped` and is not counted as a failure.
5. fsync the file, rename it into place, then fsync the directory.
6. Write a `BACKUP_CREATED` audit entry: `{ full: true, file, files, bytes, verified }`.

On any failure, remove `.partial` and release the lock.

Memory is bounded by one chunk plus the stream buffers, whatever the backup's size. The database records are read once, so `db.json` is held in memory; it is small compared with the files.

**Settings button** (admin only):
- `POST /api/backup/full { passphrase }` starts the engine as an in-process background job and returns 202 with a job id.
- `GET /api/backup/full/status` returns progress: files and bytes done and total, state, and the file name or error. The UI polls it.
- Only one job runs at a time; this shares the lock with the engine.

**`./backup.sh` / `backup.bat`:**
- If the app is running, run the engine with `docker compose exec -T -u 1001 blackvault node scripts/full-backup.mjs`; otherwise use `docker compose run --rm`.
- **Passphrase:**
  - `--passphrase-file <path>`: the file is read on the host and passed on stdin.
  - With no flag, prompt with echo turned off.
  - The passphrase never appears in argv or the environment.
- `--keep N` (default 7):
  - After a successful backup, run `--verify` on the new file.
  - Only if verification passes, delete the oldest `blackvault-full-*.bvb` files beyond N.
  - If verification fails, delete nothing and exit 1.
- `--verify <file>`: stream-decrypt the whole archive and check every file's sha256 against the manifest. Nothing is written to disk.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | failed |
  | 2 | another backup is already running |

## 3. Restore, re-encryption, errors, testing

### `./restore.sh <file>` / `restore.bat`

1. **Get the passphrase**, from `--passphrase-file` or a prompt.
2. **Verify first**, in a one-off container as uid 1001: the full stream decrypt and the manifest check. If this fails (wrong passphrase, or a damaged, truncated or unknown-version archive), exit 1 with nothing changed.
3. **Stop the app.** Run `scripts/db-snapshot.sh`, which snapshots the database and uploads (3b). Stop if it fails.
4. **Restore**, in a one-off container as uid 1001:
   1. Stream the archive again. Write each file **encrypted under the current key** (`writeEncryptedFile` semantics) into `uploads/.restore-<ts>/{images,documents}/`.
   2. Replace the database records in one transaction, through the existing restore logic. That logic is extracted into a shared module used by both `/api/backup/restore` and the script.
   3. Rename the current `images/` and `documents/` to `uploads/.pre-restore-<ts>/`, then rename the staged folders into place.
5. **Failure handling.** If step 4 fails, the wrapper restores the database and uploads from the step-3 snapshot, starts the app, and exits 1. If the host crashes partway through, the printed recovery text names that snapshot.
6. **Finish.** Start the app and write a `RESTORE` audit entry: `{ full: true, file, files }`. The app's startup file step (3b) sees only `BVF1` files under the current key.

### `./reencrypt-files.sh --from-key-file <path>` / `.bat`

- Runs with the app stopped, in a one-off container as uid 1001.
- Every `BVF1` file whose key id matches the given old key is decrypted with it, re-encrypted under the current key, and written atomically. It reuses the rotation script's file code; nothing is duplicated.
- Idempotent: files already under the current key are skipped.
- Exit codes:
  - 3 if no file matches the old key, or if the old key file is invalid;
  - 1 on failure;
  - 0 on success.
- It never deletes a key file, and never deletes a file it has not just replaced.
- **README:** the "Files encrypted with a different key" section gains this tool as recovery option C.

### Errors

| Situation | Result |
|---|---|
| Wrong passphrase; damaged, truncated or reordered archive; unknown version or KDF parameters | Refused before any change |
| Disk full while backing up | `.partial` is removed; exit 1 |
| Disk full while restoring | Automatic rollback from the snapshot |
| A second backup is already running | Exit 2, or HTTP 409 from the button |

### Tests

- **Unit tests for the format.** Round trip at sizes 0, 1 byte, 1 MiB±1 and several chunks. Each of these must be rejected:
  - reordered, dropped or duplicated chunks;
  - a missing final chunk, or trailing bytes;
  - a changed header or a wrong passphrase;
  - hostile KDF parameters, rejected quickly.
- **Streaming.** A 5 GB synthetic stream (sparse source data) is sealed, opened and verified. Peak RSS stays under a fixed cap, for example 300 MB.
- **Real filesystem and real database, on SQLite (`connection_limit=1`) and Postgres:**
  - a full backup restored onto an install with a **different key** gives identical records and identical file sha256s;
  - the lock works, including stale-lock reclaim;
  - `--keep` deletes only after verification passes;
  - a failure injected at each restore step rolls back to the snapshot exactly;
  - `reencrypt-files` recovers a copied folder, re-running it does nothing, and a wrong key exits 3.
- **Injection proofs.**
  - Drop the final-flag check: the truncation test must fail.
  - Drop the counter from the AAD: the reorder test must fail.
- **CI, real Linux Docker:**
  - run `backup.sh` with `--passphrase-file` against a seeded install;
  - run `restore.sh` onto a second install with a different key;
  - check that every file serves its original sha256, and that the record counts match;
  - run `--keep` rotation with a corrupted newest backup: nothing may be deleted.

### Acceptance criteria

1. A backup plus its passphrase rebuilds the full install (records, photos and documents) on a machine with a **different key**.
2. A wrong passphrase, or a damaged or truncated archive, changes nothing.
3. A backup with 5–10 GB of files runs in bounded memory, from both the button and `backup.sh`.
4. `--keep` never deletes a backup unless the newest one has verified.
5. A failed restore leaves the install exactly as it was.
6. `reencrypt-files.sh` recovers a copied uploads folder when the old key is available.
7. CI is green on Windows and on both time-zone legs. The Linux Docker job proves criteria 1, 2 and 5.

## Known limitations

- **The backup is point-in-time.** It reflects the database at the moment it was read. Files uploaded during the backup are not included.
- **No incremental backups.** Each backup is a full copy, and space is managed with `--keep`.
- **The passphrase must be supplied for every run.** A cron job therefore needs a passphrase file, which the user must store safely. Keep it off the BlackVault host if possible.
- **Full restore is command-line only.**
- **Recovering files under another key needs that key.** `reencrypt-files` needs the old key; without it, the files are unrecoverable.
