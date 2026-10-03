# Full backups with files, and re-encrypting copied files (spec 3c of the auth epic)

- **Status:** implemented on `feat/full-backups` (draft PR #25); not merged. Approved in conversation on 2026-10-02. Where the shipped behaviour differs from the text below, "Changes during implementation" at the end says how and why.
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

## Changes during implementation

Each item is a shipped deviation from the text above, or something the text did not decide, with the reason. Sources: the rulings (R-numbers) in `.superpowers/sdd/2026-10-02-full-backups/progress.md`, and the code, which is what each item was checked against.

### Archive (§1)

- **`manifest.json` is the LAST tar entry**: `db.json`, then `files/...`, then `manifest.json` (§1 said first). A manifest written first needs every file's sha256 before the first byte is sealed — a second pass that decrypts 5–10 GB twice — and cannot record a file that vanishes after it was written. Verify and restore hash each entry while streaming and compare with the manifest at the end; restore therefore changes nothing until the whole archive has been read. `src/lib/backup/full-backup.ts`, `full-verify.ts`, `full-restore.ts`.
- **The reader is stricter than ustar asks.** Both end-of-archive zero blocks are required and every byte after them must be zero; duplicate names, a directory entry with a size, `.`/`..`/empty segments, backslashes and invalid UTF-8 are refused. It only ever reads archives this code wrote. `src/lib/backup/tar.ts`.
- **A cut in the middle of a later chunk is reported as "damaged or incomplete"** under the same error code as a wrong passphrase (`WRONG_PASSPHRASE_OR_DAMAGED`); a cut, an alteration and trailing bytes cannot be told apart there. Callers show the message, not the code. A salt or nonce prefix that does not round-trip through base64url is `UNSUPPORTED`, before key derivation.
- **`sha256` and the random token use `node:crypto` outside `core.mjs`** (R13). "Crypto lives only in `core.mjs`" covers ciphers, the KDF and key handling; an integrity hash and a random file-name token are not encryption.
- **`bytes` is the plaintext size of the archived files**; the `.bvb` file's own size is reported separately as `archive_bytes` (R11). **The file-name timestamp is UTC** (the name is made on the server). **Only `uploads/images` and `uploads/documents` are walked**, as §1 lists.

### Making a backup (§2)

- **The engine is `scripts/entry/full-backup.ts`, bundled to `dist/scripts/full-backup.mjs`** (§2 said `scripts/full-backup.mjs`) (R1, R5). The engine imports the app's TypeScript modules, which plain ESM in the container cannot; `scripts/build-scripts.mjs` bundles every `scripts/entry/*.ts` with esbuild, leaving `@prisma/client` and `.prisma/*` external. `full-restore` and `reencrypt-files` are built the same way (R22).
- **The engine verifies before it publishes** (R6). The sealed `.partial` is read back in full (stream decrypt, manifest and sha256 check) before it gets its final name; a failed verify removes it and fails the run. So every `blackvault-full-*.bvb` in the folder has verified once, and the audit entry's `verified` is always `true`. Cost: the archive is read twice.
- **A file that exists but cannot be read or decrypted is skipped, loudly** (R9; §2 step 4 only spoke of files that vanish). It goes into `manifest.skipped`; the CLI prints a `WARNING:` line per file and a count, the OK line carries `skipped=` and `unreadable=`, the audit entry carries `skipped`, and the Settings panel says the backup is INCOMPLETE and lists the files. One damaged upload must not block every backup of everything else.
- **A file whose name a restore would refuse is skipped the same way** (R26), with the reason "unsupported file name": hidden segments, `*.tmp` / `*.rot`, control characters, and the second of two names that collide when case or Unicode form is ignored (or a file where another name needs a folder). One function, `src/lib/backup/entry-names.ts`, is used by the backup walk, by verify (which refuses an archive holding such a name) and by restore: a backup that verifies always restores.
- **The lock holds pid, start time and hostname, and has a heartbeat** (R10, R12; §2 step 1 said pid and start time, dead pid reclaimed). The app and a one-off container are both pid 1 in their own namespaces, so a pid alone means nothing across containers. Same hostname: live only while the pid is alive and the heartbeat (the file's mtime, refreshed every 30 s) is fresh. Another hostname, or a lock with no usable owner: live until the heartbeat is 5 minutes old. Documented limits (R14): a crashed one-off container can block new backups for up to 5 minutes; and with a dead reclaimer's guard file present, three contenders inside two adjacent system calls can produce two winners. The lock is advisory — it prevents double load. `src/lib/backup/full-lock.ts`.
- **Archive safety does not rest on the lock: a per-run token in the `.partial` name, and a publish that never replaces** (R15, R16). The work file is `blackvault-full-<ts>.<16 hex>.bvb.partial`, so two runs never share one. The final name is taken with a hard link (fails if it exists; the next second's name is tried), then the work file is unlinked. Where the folder cannot hard-link — any `link` error except `EEXIST` and `ENOENT` — it falls back to look-then-rename, which is not atomic within the same second.
- **A refused `chmod` in the backup folder is a warning, not a failure.** On a FAT/exFAT disk or a share mounted for another uid the app can create and write a file but may not chmod it (`EPERM`; also `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`). The lock file and the `.partial` were both `chmod 0600` after an exclusive create with mode 0600, so every backup there failed with `EPERM … fchmod` — right after the entrypoint had said "the app can write to it, so full backups will work". Found by running the real program on a FAT loop mount (Task 9). Now the lock ignores the refusal and the backup carries a `WARNING` that the mount decides who can read the file; any other chmod error still fails the run. `src/lib/backup/full-lock.ts` `CHMOD_REFUSED_CODES`, `full-backup.ts` `createPartial`.
- **A folder fsync that fails after the rename is a warning, not a failure**: the backup exists and has verified; the result and the CLI say so.
- **The backup folder default follows `DATA_DIR`**: `${BLACKVAULT_BACKUP_DIR:-${DATA_DIR:-./data}/backups}` (§2 said `./data/backups`) (R17). Every other mount hangs off `DATA_DIR`; a relocated install must not write its backups beside the compose file.
- **The entrypoint does not `chmod 700` after a refused `chown`**, and it tests writability by creating a file as uid 1001 rather than trusting mode bits. On a share where root owns the folder but may not chown it, 0700 would lock the app out of a folder it could write through its other bits. It warns and BlackVault starts either way. `scripts/docker-entrypoint.sh`.
- **`--keep` prunes inside the container, in the same run, with no second verify pass** (§2 said the wrapper runs `--verify`, then deletes) (R18). The host user cannot list or delete 0600 files of uid 1001 in a 0700 folder. The guarantee is the same — nothing is deleted unless this run's backup verified (R6) — and the passphrase is used once. Only files named exactly `blackvault-full-<ts>.bvb` are candidates, ordered by the name. `src/lib/backup/full-prune.ts`.
- **An interactive `backup.sh` / `backup.bat` asks for the passphrase twice** and stops on a mismatch (R19). A typo would seal a backup that verifies and that nobody can open. `--verify` and `--passphrase-file` do not ask twice.
- **One-off containers run without `--user` and without `--no-deps`** (§2 and §3 said "as uid 1001") (R20, R22). The image's entrypoint must start as root to copy the encryption key into `/run/secrets` and prepare `/app/backups`; it then drops to uid 1001 itself. Without `--no-deps`, Compose starts PostgreSQL and waits for it. `rotate-key.sh` already works this way.
- **The running-app form is `docker compose exec -T -u 1001:1001`** (§2 said `-u 1001`). With the uid alone Docker takes the group from the image's `/etc/passwd`, where that user's primary group is `nogroup` (65533), while the app itself runs as `1001:1001` (`su-exec nextjs:nodejs`). Backups made with the app running came out `1001:65533`; the Linux Docker job found it on its first complete run.
- **Windows: one PowerShell process holds the passphrase** (R23, R27). `cmd.exe` variables are inherited by every program it starts, so `backup.bat` and `restore.bat` never hold the passphrase: one PowerShell process reads the file or asks without echo, starts docker itself and writes the passphrase into its standard input. `restore.bat` asks once and feeds both the check and the restore.
- **`BLACKVAULT_BACKUP_TIMEOUT`** (seconds) optionally bounds how long the wrapper waits. No limit by default.
- **The Settings panel shows two phases**, writing and verifying, each with its own bar: the byte counters change unit between them. It stops polling after repeated status failures and says the backup may still be running. A start while the lock is taken answers 409.

### Restore (§3)

- **A restore must be confirmed** (the spec was silent) (R21): an interactive run asks the user to type `RESTORE`; a run without a terminal needs `--yes` and otherwise stops before anything is checked. A mistyped file name or a stray cron line must not replace an install.
- **Step order inside the restore is stage → check → database → folders**, and the `RESTORE` audit entry is written by the restore program after the folder swap, not by the wrapper after the app starts (§3 step 6). The audit table is not part of a backup, so the entry survives the replace.
- **The restore holds the full-backup lock for its whole run.** A cron backup during a restore would archive a half-restored install, and its `--keep` could then delete a good backup.
- **The database rollback is gated on a marker** (amends §3 step 5, "if step 4 fails, restore the database") (R24). The restore program creates `uploads/.restore-<ts>.db-started/`, durably, just before its database step, and removes it only when everything is in place. The wrapper puts the DATABASE back only when the marker exists; the uploads are always put back and compared with the snapshot. A failure that changed nothing must not put the live database through destroy-and-reload; writing the marker before the commit covers a commit whose acknowledgement was lost.
- **Three states, enforced inside `scripts/snapshot-restore.sh`** (R28). `started`: the marker exists — roll back. `complete`: no marker, but `.pre-restore-<ts>` holds a previous folder — the restore finished and only its exit status was lost: nothing is rolled back, exit 0 with a `WARNING` that the OK line and the audit entry may be missing. `untouched`: neither. Because the script itself applies the rule, neither wrapper nor a person following the recovery text can undo a finished restore. The wrapper refuses to start if this run's `.pre-restore-<ts>` already exists.
- **The RECOVERY file** (§3 step 5 said "the printed recovery text") (R25). Before the restore step the wrapper prints the recovery block and writes it to `backups/restore-<ts>-RECOVERY.txt`: where the snapshot is and the exact commands. It is removed on success and after a successful rollback. A new restore refuses to start while one exists. The one-off restore container has a fixed name, so an interrupt can stop it — and see it gone — before anyone is told to run rollback commands.
- **Rollback order: uploads first, then the database.** Removing the staging folder first frees the space the database copy may need on a full disk.
- **The PostgreSQL rollback loads into a side database and swaps.** The `pg_dump` snapshot is loaded into a new `blackvault_rollback` database in one transaction; only then is `blackvault` dropped (`WITH (FORCE)`) and the new one renamed. A dump that does not load leaves the live database alone. SQLite: the snapshot is copied beside the live file, compared, then renamed over it. `scripts/snapshot-restore.sh` does the file work as root in a one-off container (the snapshot and the live files belong to different users).
- **`.restore-*` and `.pre-restore-*` are excluded** from the 3b startup scan, the uploads snapshot and the backup walk (R2).
- **Windows: `restore.bat` has no interrupt handler.** A batch file cannot catch Ctrl-C or a closed window; the recovery file is what remains.

### Re-encrypt (§3)

- **It reuses `storage.ts` `writeAtomic` and `core.mjs` directly**, as a bundled TypeScript entry, not the rotation script's file code (§3 said it reuses that) (R3). The rotation script's copies are hand-kept mirrors for plain ESM; duplicating them again would add a third.
- **Exit codes are decided from the disk alone** (R29): 0 when at least one file was under the old key and all of them were re-encrypted; 3 when no file is under the old key — which is also what a second run answers — or the key file is missing, empty, not a key, or is the current key; 1 on failure. Files under some other key are a `WARNING` count and do not change the exit code. The spec said both "re-running is a no-op" and "3 if no file matches"; a second run matches nothing.
- **Skip and continue** (R31). An old-key file that cannot be decrypted is counted (`failed=`), named, and the run goes on to the rest, ending in exit 1. Stopping at the first would strand every file sorted after a damaged one. A one-line summary (`BLACKVAULT_REENCRYPT_<OK|NOTHING|FAILED> … stopped=<0|1>`) is printed on exit 1 too. A replaced file that cannot be read back is reported as replaced but unconfirmed.
- **The old key is treated like a passphrase** (R30): read on the host and sent on standard input, never in argv, the environment or the container's filesystem. The app is restarted only if it was running before. A failed restart after a successful re-encryption is exit 1, with a message that the re-encryption itself completed (R31). No audit event, snapshot or lock is added; the spec asks for none.

### Tests and CI

- **The memory test is 2 GiB through the whole engine**, in a child process, not a 5 GB synthetic stream through the sealer alone (R7, R8). Peak RSS under 300 MB is asserted on Linux (CI's `verify` job, `RUN_SLOW_TESTS=1`); elsewhere the bound is 512 MB, because macOS counts freed pages.
- **Counter-in-AAD injection.** Removing the counter from the AAD alone does not make the reorder test fail: the counter is also in the nonce. The proof removes it from both.
- **CI's "`--keep` with a corrupted newest backup" is met in two halves** (R32): `backup.sh --verify` on a corrupted copy exits 1, and a backup that fails mid-run with `--keep 1` deletes nothing. Under R18 a backup cannot be corrupted from outside between its own verify and its prune, and no test-only hook was added to production code; the exact case stays proven by the engine's CLI test.
- **The Linux Docker job also runs the sequence on PostgreSQL** and a restore that fails after its database step (made by turning `uploads/documents` into a mount point). `scripts/ci/full-backup-linux.sh`.
- **Not covered by automation:** the typed prompts on Windows (every Windows scenario uses `--passphrase-file` and `--yes`), and a full restore driven from a browser (there is none).

## Known limitations added during implementation

- A damaged upload, or a file with a name a restore would refuse, is left out of the backup (loudly) rather than failing it.
- The lock's limits above: "already running" for up to 5 minutes after a crashed one-off container.
- On a folder without hard links, two runs publishing in the same second could replace one another.
- `.pre-restore-<ts>` and the pre-restore snapshot are never deleted automatically and use disk.
- A stale RECOVERY file blocks restores until the user clears it.
- Windows has no interrupt handler in `restore.bat`.
- On a backup folder that refuses `chmod`, the backup file's mode is whatever the mount gives it (a warning says so).
