# Full Backups and File Re-encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One passphrase-sealed archive (`.bvb`) holds database records plus decrypted uploads. It is created from a Settings button or by `backup.sh` (cron), and restored by `restore.sh` onto any key with automatic rollback. A `reencrypt-files.sh` tool recovers a copied uploads folder from an old key.

**Architecture:**
- **Streaming crypto:** `core.mjs` gains a streaming chunked AES-GCM sealer and opener (format BVB1).
- **Archive code:** `src/lib/backup/tar.ts` writes and reads a minimal ustar stream. `src/lib/backup/full-backup.ts` (engine), `full-restore.ts` and `reencrypt-files.ts` hold the logic.
- **Script bundles:** TypeScript engines the container scripts must reach (the app Prisma client with encryption, `storage.ts`, restore core) are bundled with esbuild at image build time into `dist/scripts/*.mjs`. CLI entrypoints run them with `node`, and the app's API imports the same TypeScript.
- **Host wrappers:** `backup.sh`/`.bat`, `restore.sh`/`.bat` and `reencrypt-files.sh`/`.bat` follow the 3b rules: uid 1001 in-container, `timeout`s, probe-before-delete, explicit exit codes.

**Tech Stack:** Node streams + `node:crypto` (AES-256-GCM, scrypt), Prisma 5.22 (SQLite `connection_limit=1` / PostgreSQL 17), Next.js 16 route handlers, esbuild (already in `node_modules`; pin it as a devDependency), Vitest 2, Bash and Windows batch, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-full-backups-design.md` (decisions D1–D6). It builds on 3a and 3b, including their "Changes during implementation" sections.

## Global Constraints

- **BVB1 header** (JSON, length-prefixed): `format "blackvault-full-backup"`, `version 1`, `kdf {scrypt, N 65536, r 8, p 1, salt 16B}`, `cipher "aes-256-gcm-stream"`, `noncePrefix 8B`, `chunkSize 1048576`. Any other KDF values are rejected BEFORE derivation.
- **BVB1 chunks:**
  - Nonce: `noncePrefix ‖ uint32be(counter)`, with the counter starting at 0.
  - AAD: `canonicalHeader ‖ uint32be(counter) ‖ finalFlag(1 byte)`.
  - Each chunk ends with a 16-byte tag.
  - Reject reorder, drop, duplicate, a missing final chunk, and trailing bytes.
- **Plaintext:** a ustar tar holding, in order, `db.json`, `files/images/...`, `files/documents/...`, `manifest.json`. It skips `.pre-encryption-*`, `*.tmp`, `*.rot`, hidden entries and symlinks.
  - *Corrected 2026-10-03:* this line said the order starts with `manifest.json`. `manifest.json` is the LAST entry (Task 2 ruling; see the spec's "Changes during implementation"). Task text below that still says "manifest first" predates the ruling.
- **Backup storage:**
  - File name: `blackvault-full-<YYYYmmdd-HHMMSS>.bvb`, mode 600.
  - Folder: `/app/backups`, mounted from `${BLACKVAULT_BACKUP_DIR:-./data/backups}`. The entrypoint, as root, makes it 1001:1001 mode 0700.
  - Writes go to a `.partial` file that is created empty, chmodded 0600, filled, fsynced, renamed, and then the directory is fsynced.
- **Lock:** `/app/backups/.full-backup.lock`, holding pid + startedAt. A dead pid is reclaimed. A second run exits 2, or returns HTTP 409.
- **Passphrase:** NFC-normalised, at least 12 code points. It never appears in argv or the environment. It comes from `--passphrase-file` (read on the host and passed on stdin) or from a no-echo prompt.
- **`--keep N`:** default 7. It deletes the oldest `blackvault-full-*.bvb` beyond N, only after the new backup's `--verify` passes.
- **Exit codes:**
  - backup: 0 ok, 1 failed, 2 already running;
  - reencrypt: 3 means no matching files or a bad key file;
  - restore: 1 failed (rolled back).
- **Audit:**
  - `BACKUP_CREATED {full:true, file, files, bytes, verified}`
  - `RESTORE {full:true, file, files}`
- **Rules inherited from 3a and 3b:**
  - crypto code lives only in `core.mjs` (types in `core.d.mts`);
  - routes use `storage.ts` (guard test);
  - write files with `writeAtomic`;
  - env keys use the `BLACKVAULT_` prefix;
  - stage explicit paths only;
  - never touch `prisma/prisma/dev.db`, the `dashboard` host, or the `certwarden` container;
  - wrap every docker command in `timeout`.

## Review Focus

1. **Backup folder on a NAS mount (NFS/SMB) where chown is refused.** The entrypoint must log a clear warning and keep going if the folder is already writable. If it isn't writable, the button and `backup.sh` must fail with a message that names the folder. Test owner: Task 6.
2. **Archive that ends exactly on a chunk boundary, or an empty uploads folder.** The final flag must still be set, on a zero-length final chunk if needed. Test owner: Task 1.
3. **A file deleted, or a new upload, while a backup runs (app is up).** The deleted file goes to `manifest.skipped`, the new upload is simply absent, and the backup still verifies. Test owner: Task 4.
4. **Restore onto a machine whose uploads folder has extra files not in the backup.** They move to `.pre-restore-<ts>/` with the rest, so nothing is silently deleted. Test owner: Task 7.
5. **Cron with no TTY.** If `backup.sh` gets no `--passphrase-file` and has no TTY, it must exit 1 with an error instead of hanging on a prompt. Test owner: Task 6.

---

### Task 1: Streaming BVB1 sealer and opener (core.mjs)

**Files:** Modify `src/lib/encryption/core.mjs`, `core.d.mts` and `core.test.ts`.

**Interfaces:**
- Produces:
  - `BVB_FORMAT = "blackvault-full-backup"`
  - `createBackupSealer(passphrase: string): Transform` writes the header, then sealed chunks.
  - `createBackupOpener(passphrase: string): Transform` reads and validates the header, emits plaintext, and errors with `SealError("WRONG_PASSPHRASE_OR_DAMAGED" | "UNSUPPORTED" | "TRUNCATED")`.

- [ ] **Step 1: Failing tests.**
  - Round trip at 0 B, 1 B, 1 MiB−1, 1 MiB, 1 MiB+1, and 3.5 MiB. Review Focus 2: a stream that ends exactly on 1 MiB still decodes, and its last chunk carries the final flag.
  - Reject swapped chunks (`WRONG_PASSPHRASE_OR_DAMAGED`).
  - Reject a dropped middle chunk.
  - Reject a duplicated chunk.
  - Reject a body cut off after a non-final chunk (`TRUNCATED`).
  - Reject bytes after the final chunk.
  - Reject a header byte changed.
  - Reject a wrong passphrase.
  - Reject `N=2**30` / `r=64` / `p=16`, with `UNSUPPORTED`, in under 200 ms.
  - Reject a passphrase under 12 code points (`PASSPHRASE_TOO_SHORT`) when sealing.
  - An NFD passphrase must open a backup sealed with the NFC form.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3: Implement.**
  - Header: 4-byte big-endian length, then canonical JSON (reuse `canonicalJson`).
  - The sealer buffers until a full chunk is ready, and holds the last chunk back until flush so it can set the final flag. An empty stream yields one empty final chunk.
  - The opener validates KDF values with strict equality before `scryptSync`. It derives the key once and uses `authTagLength: 16`.
- [ ] **Step 4:** Make the tests PASS. Then run typecheck and lint.
- [ ] **Step 5: Injection.** Remove the counter from the AAD: the reorder test must FAIL. Remove the final-flag check: the truncation test must FAIL. Restore both.
- [ ] **Step 6:** Commit with `feat(backup): streaming BVB1 sealer and opener in the crypto core`.

### Task 2: Minimal ustar writer and reader, and the manifest

**Files:** Create `src/lib/backup/tar.ts`, `src/lib/backup/manifest.ts`, and tests for both.

**Interfaces:**
- `class TarWriter { constructor(out: Writable); addFile(path: string, size: number, source: Readable): Promise<void>; addBuffer(path: string, buf: Buffer): Promise<void>; finish(): Promise<void> }`
- `readTar(input: Readable, onEntry: (path: string, size: number, body: Readable) => Promise<void>): Promise<void>`
- `Manifest` type, plus `buildManifest(...)` and `parseManifest(buf)`, which validates and rejects unknown `formatVersion`.

- [ ] Tests:
  - round trip with nested paths, a path longer than 100 characters (ustar prefix), empty files and a 25 MB file;
  - reject `..` and absolute paths on read, and skip entry types other than regular files and directories;
  - a corrupt header checksum fails.
- [ ] Implement, with no new dependency. Follow the steps: RED, GREEN, typecheck, lint, injection (break the checksum check and the corrupt test must fail), then commit with `feat(backup): ustar writer/reader and backup manifest`.

### Task 3: esbuild script bundles in the image

**Files:**
- Modify `package.json`: add `esbuild` as a devDependency pinned to the installed version, and a `build:scripts` script.
- Modify `Dockerfile`: in the builder stage, run `npm run build:scripts`. In the runner stage, `COPY dist/scripts`.
- Create `scripts/build-scripts.mjs`, which lists entrypoints, plus a test.

**Interfaces:**
- Produces `dist/scripts/{full-backup,full-restore,reencrypt-files}.mjs`.
- Bundled with `--platform=node --format=esm`, with Prisma clients (`@prisma/client`, `.prisma/*`) left external, and `@/` resolved.

- [ ] Write a test that `scripts/build-scripts.mjs` builds a tiny probe entrypoint importing `@/lib/files/storage` and `@/lib/encryption/core.mjs`, and that running the output with `node` prints the expected root.
- [ ] Implement it. CI's Docker build job must still pass, so confirm it by pushing.
- [ ] Commit with `build(scripts): bundle TypeScript CLI engines into the image`.

### Task 4: Full-backup engine, lock and verify

**Files:**
- Create `src/lib/backup/full-backup.ts`, `src/lib/backup/full-lock.ts`, `src/lib/backup/full-verify.ts`, and `scripts/entry/full-backup.ts` (the CLI entry: it reads the passphrase from stdin and handles `--verify <file>`).
- Tests: real-filesystem and real-database tests on SQLite with `connection_limit=1`, plus Postgres when `ENCRYPTION_REAL_DB_PG_URL` is set.

**Interfaces:**
- `runFullBackup({ passphrase, dir = "/app/backups", onProgress? }): Promise<{ file, files, bytes }>`
- `verifyFullBackup(file, passphrase): Promise<{ files, bytes }>`
- `acquireFullBackupLock(dir) / release`

Data comes from the app Prisma client (decrypted) for `BACKUP_MODELS` (`src/lib/backup/models.ts`), and from `readDecryptedFile` for uploads.

- [ ] Tests:
  - a backup verifies, and its manifest counts and sha256s match;
  - Review Focus 3: delete a file mid-run (hook into `onProgress`) and it lands in `manifest.skipped`, and the backup still verifies;
  - a second concurrent run gets the lock error, and a stale lock with a dead pid is reclaimed;
  - an injected write failure removes `.partial` and releases the lock;
  - a `BACKUP_CREATED` audit entry is written;
  - peak RSS stays under 300 MB for a backup of 2 GB of sparse files (on CI, use a `RUN_SLOW_TESTS` gate);
  - the archive bytes contain no plaintext needle.
- [ ] Then: injection proof (skip verify's sha256 check, and a corruption test must fail), then commit.

### Task 5: Settings button, API and status

**Files:**
- Create `src/app/api/backup/full/route.ts` (POST) and `src/app/api/backup/full/status/route.ts` (GET), plus tests.
- Modify `src/app/settings/SettingsView.tsx` and its test.

**Behaviour:**
- Admin only.
- POST validates the passphrase, starts `runFullBackup` as a module-level singleton job and returns `202 {jobId}`. While a job is running, POST returns `409`.
- GET returns `{state, filesDone, filesTotal, bytesDone, bytesTotal, file?, error?}`.
- The UI shows passphrase and confirm fields (`new-password`), a progress bar and the result.
- The job keeps running if the page closes.

- [ ] Test RED → GREEN, browser-free, using component tests. Then run the guard test, typecheck and lint. Commit.

### Task 6: `backup.sh` / `backup.bat`, compose mount, entrypoint

**Files:**
- Create `backup.sh` and `backup.bat`.
- Modify `docker-compose.yml`, `docker-compose.dev.yml` (the `/app/backups` mount and `BLACKVAULT_BACKUP_DIR`), and `scripts/docker-entrypoint.sh` (mkdir, then chown 1001:1001, chmod 0700). If chown fails (Review Focus 1), log a warning and continue only when the directory is writable by 1001.
- Tests: `scripts/installers-encryption.test.ts` (or a new `scripts/full-backup-wrapper.test.ts`) with the docker stub, and Windows harness scenarios in `Test-WindowsInstallers.ps1`.

**Behaviour:**
- If the app is running, use `docker compose exec -T -u 1001 blackvault node dist/scripts/full-backup.mjs`. Otherwise use `compose run --rm -T --no-deps --user 1001:1001`.
- The passphrase is sent on stdin.
- `--keep N`: run verify, and only after it passes, delete the oldest files beyond N.
- `--verify <file>`.
- Review Focus 5: with no TTY and no `--passphrase-file`, exit 1.
- Exit codes are 0, 1 and 2.

- [ ] Tests:
  - the passphrase never appears in the stub's recorded argv or env;
  - `--keep` with a corrupted newest file deletes nothing and exits 1;
  - keep=2 with 4 good files deletes exactly the 2 oldest;
  - the lock returns exit 2.

  Then commit.

### Task 7: Restore engine and `restore.sh` / `restore.bat` with rollback

**Files:**
- Create `src/lib/backup/restore-core.ts`, the restore logic extracted from `src/app/api/backup/restore/route.ts`. The route now calls it, so it is shared and not copied.
- Create `src/lib/backup/full-restore.ts`, `scripts/entry/full-restore.ts`, `restore.sh` and `restore.bat`, plus tests.

**Steps inside the wrapper:**
1. Verify the backup in a one-off container.
2. Stop the app and run `db-snapshot.sh`.
3. In a one-off container running as 1001:
   - stage files encrypted under the CURRENT key into `uploads/.restore-<ts>/`;
   - run the DB transaction through `restore-core`;
   - rename the current `images/` and `documents/` into `uploads/.pre-restore-<ts>/`, then rename the staged folders into place.
4. On failure, restore the snapshot automatically: the DB, plus uploads using the db-snapshot contents.
5. Start the app.
6. Write a `RESTORE {full:true}` audit entry.

Also exclude `.restore-*` and `.pre-restore-*` from the 3b startup scan and from the uploads snapshot.

- [ ] Tests:
  - restoring onto an install with a DIFFERENT key gives identical records and file sha256s, and every file carries the new key id;
  - a failure injected at each of these points leaves the install byte-identical to before: after staging, after the DB commit, and mid-rename;
  - Review Focus 4: extra files end up in `.pre-restore-<ts>/`;
  - the existing browser-restore tests still pass, proving `restore-core` is shared.

  Then commit.

### Task 8: `reencrypt-files`

**Files:** Create `src/lib/files/reencrypt.ts`, `scripts/entry/reencrypt-files.ts`, `reencrypt-files.sh` and `reencrypt-files.bat`, plus tests. Update the README section "Files encrypted with a different key", adding recovery option C.

**Behaviour:**
- Runs with the app stopped, in a one-off container as 1001.
- Every BVF1 file whose key id matches the old key is re-encrypted under the current key with `writeAtomic`.
- Exit codes:
  - 3 when no file matches or the old key is invalid;
  - 1 on failure;
  - 0 on success.
- Running it twice is safe: the second run finds nothing to do.

- [ ] Tests: a mixed folder, re-running is a no-op, a wrong key exits 3, an injected failure halfway leaves every file readable under one of the two keys, and afterwards the app's startup accepts the folder. Then commit.

### Task 9: CI on real Linux Docker, docs and spec changes

- Extend `scripts/ci/encryption-key-linux.sh`:
  1. Seed install A.
  2. Run `backup.sh --passphrase-file` (the file is on the runner).
  3. Run `restore.sh` onto install B with a different key.
  4. Check that every file serves its original sha256 and the record counts match.
  5. Run `--keep` with a corrupted newest backup: nothing is deleted and the exit code is 1.
  6. Run `reencrypt-files.sh` on a copied uploads folder.
- In README and CONTRIBUTING, check every sentence against the code and record its file:line in the report. Cover:
  - full backups (button, cron example, `--passphrase-file` advice, `--keep`, the backup folder / `BLACKVAULT_BACKUP_DIR`, NAS notes);
  - restore;
  - reencrypt;
  - the limitations.
- Add a "Changes during implementation" section to the spec.
- Commit, push, and get CI green.

### Task 10: Verification on real local Docker, and the PR

- **Checks:** run lint, typecheck, `npm test` three times, and the build. Then, on OrbStack, using resources prefixed `bvbk-t10-`:
  - a button backup of about 1 GB of uploads;
  - `backup.sh` from cron with `env -i` (no TTY);
  - restoring onto a second install with a new key;
  - a failed-restore rollback;
  - `reencrypt-files`;
  - the browser flow with screenshots.
- **Acceptance table:** map the spec's 7 criteria to evidence.
- **PR:** open it with `gh pr create --repo doomcrewinc/BlackVaultArmory --base develop`. The body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Mark it ready once CI is green and nothing Important is open. Never merge.
