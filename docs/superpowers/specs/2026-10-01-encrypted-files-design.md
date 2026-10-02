# Encrypted files at rest — design (spec 3b of the auth epic)

- **Status:** approved in conversation on 2026-10-01; this written spec is awaiting review.
- **Builds on:** spec 3a, field encryption (`ebdbf36`). This spec reuses its key, `src/lib/encryption/core.mjs`, the startup sequence, rotation and the update scripts.
- **Next:** spec 3c will put the uploaded files inside sealed backups.

## Goal

Uploaded photos and documents are stored encrypted with a file key. That key is derived from the 3a server-held key. Signed-in users see photos and documents exactly as they do today. Anyone holding only the disk, the uploads volume, or a copy of the uploads folder cannot read them.

A photo of a receipt or a Form 4 usually shows the serial number. Without this spec, 3a's field encryption leaves that serial readable in the image.

## Threat model

The threat model is the same as 3a's: a stolen or copied disk or volume, a leaked copy of the folder, and compliance. The server key is accepted. Anyone who controls the running server can read everything.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | 3b covers encryption at rest and the fix for where documents are stored. Putting files inside backups is spec 3c. | user (C) |
| D2 | Existing documents are rescued by a one-time copy command in the release notes. On startup, the app also checks for documents whose files are missing, and logs and audits them by name. It does not refuse to start. | user (B) |
| D3 | One file key encrypts every uploaded file, using whole-file AES-256-GCM per file. Each file records which key encrypted it. Rotation re-encrypts every file. | user (A) |
| D4 | File responses send `Cache-Control: private, no-store`. | user (section 2) |

## Current state (on `develop` ebdbf36)

- **Documents are written outside any volume.** The document upload route (`src/app/api/documents/upload/route.ts`) writes to `getCanonicalUploadsRoot()/documents`, which is `/app/storage/uploads/documents` (`src/lib/upload-security.ts:88-90`). Compose mounts only `/app/data` and `/app/uploads` (`docker-compose.yml:100-101`). Uploaded documents therefore sit in the container's writable layer and are lost whenever the container is recreated. This is about 85% likely and has not been confirmed on a live install.
- **Images are on the volume.** The image upload route (`src/app/api/images/upload/route.ts`) writes to `IMAGE_UPLOAD_DIR`, or `<cwd>/uploads` (`/app/uploads`) when that is unset. That path is mounted.
- **Serving reads the whole file.** `/uploads/[...path]` serves images and `/api/files/documents/[fileName]` serves documents. Both read the whole file with `fs.readFile`. Neither supports Range requests or thumbnails, and nothing uses `next/image` for uploads. Pages render plain `<img src="/uploads/...">` tags.
- **Backups hold paths only.** Backups store file paths, never file contents.

## 1. Format and location

### File key

The file key is `HKDF-SHA256(master key, salt = empty, info = "blackvault/file-encryption/v1", 32 bytes)`. It is added to `deriveKeys()` in `core.mjs` as `file`. The known-answer tests are extended to cover it.

### File format

| Bytes | Content |
|---|---|
| 0–3 | ASCII `BVF1` (magic) |
| 4 | version, `0x01` |
| 5–12 | key id, 8 ASCII hex characters (as in 3a) |
| 13–24 | IV, 12 random bytes |
| 25 … n−17 | ciphertext |
| n−16 … n−1 | GCM tag, 16 bytes |

- **AAD:** bytes 0–12 of the header, followed by the UTF-8 basename of the file, for example `3f9a…c1.pdf` or `cmh2…_1727.jpg`. Binding to the basename stops bytes being swapped between files. Moving a file to another folder still decrypts.
- **Plaintext detection:** a file that does not begin with `BVF1` is plaintext.
- **Implementation:** `core.mjs` gains `encryptFile(keys, basename, buffer) → buffer`, `decryptFile(keys, basename, buffer) → buffer` and `isEncryptedFile(buffer)`. `decryptFile` passes `{ authTagLength: 16 }`, a lesson from 3a. It throws `KEY_MISMATCH` when the key id differs, and a coded error when the file is malformed.

### Location

- **One uploads root:** `uploadsRoot()` is `IMAGE_UPLOAD_DIR` when set, otherwise `<cwd>/uploads`. That is `/app/uploads` in Docker and `./uploads` in development.
- **Documents move** to `<uploadsRoot>/documents`.
- **Document URLs do not change.** `Document.fileUrl` stays `/api/files/documents/<name>`. Only the storage root behind that route changes, so no database rows are rewritten.
- **The old folder stays known.** The old root `<cwd>/storage/uploads/documents` is kept as `legacyDocumentsRoot()` and is used only by the startup move step.

### Atomic writes

1. Encrypt the file in memory.
2. Create `<name>.tmp`, empty, with mode 0600. The file is created empty, then chmodded, then written; this is 3a's lesson about default ACLs.
3. Write the file, then `fsync` it.
4. `rename` the `.tmp` file to `<name>`, then `fsync` the directory.

At startup, any leftover `*.tmp` files under the uploads root are deleted.

## 2. Serving, uploading, startup

### Serving

`src/app/uploads/[...path]/route.ts` and `src/app/api/files/documents/[fileName]/route.ts` work as follows:

- **Unchanged:** both read the file, path validation, Content-Type, and the existing security headers.
- **Decryption:** the file is decrypted with the current keys and the plaintext is returned.
- **Caching:** `Cache-Control: private, no-store` replaces `max-age`.
- **Plaintext file after the migration:** HTTP 500 with a generic body, and an error log naming the file. This is the file equivalent of 3a's `PLAINTEXT_AT_REST`.
- **Decrypt or authentication failure:** HTTP 500 with a generic body, and an error log naming the file and the error code.

### Uploading

Both upload routes keep their current validation: magic bytes, size, type, auth and rate limits. After validating, they encrypt the file and write it atomically. Neither route ever writes a plaintext file.

### Startup

These steps run in `src/lib/encryption/startup.ts`, after 3a's database migration and compaction, and before the date migration.

1. **Move documents.** Every regular file in `legacyDocumentsRoot()` is moved to `<uploadsRoot>/documents`. The move is a rename, or a copy, fsync and unlink when it crosses filesystems. If a file with the same name already exists, it is kept and the legacy copy is logged and left in place.
2. **Pre-encryption snapshot.** If any plaintext files exist, all plaintext files are copied to `<uploadsRoot>/.pre-encryption-<ts>/`, keeping their relative paths, with mode 0600 and directory mode 0700, before anything is encrypted.
   - The snapshot is skipped if an equivalent snapshot from the update script already exists. The update script sets an env or marker to say so.
   - If the copy fails, for example because the disk is full, startup is refused. The error says how much space is needed.
   - The log states that the snapshot is plaintext, that it needs `sudo` to delete on Linux, and its host path.
3. **Encrypt.** Every plaintext regular file under the uploads root is encrypted in place with an atomic write. Excluded are `.pre-encryption-*` folders, `.tmp` and `.rot` files, and hidden files.
   - The step is idempotent: already-`BVF1` files are skipped.
   - It resumes after a crash: files already encrypted stay encrypted.
   - An unreadable or unwritable file refuses startup and names the path. Every file already processed stays consistent.
4. **Missing documents.** Every `Document` row whose file does not exist under the new root is logged as one line per document, with id, name and item. The app does not refuse to start.
5. **Audit.** One `FILES_ENCRYPTED` audit event (actor `system`) is written only when something changed. Its `changes` are `{ counts: { images: n, documents: n }, moved: n, missing: [{ id, name }], keyId, snapshot: "<host path>" }`. The new action belongs to the `security` group and has a non-default `summarize()` text.

### Update scripts

`scripts/db-snapshot.sh` and `.bat` also copy the uploads folder into `backups/uploads-<ts>/` with modes 600/700. They then mark that a snapshot was taken, for step 2 above. The update stops if this copy fails.

## 3. Rotation

This extends `scripts/rotate-encryption-key.mjs` and the `rotate-key.sh` / `.bat` wrappers.

1. **Stage.** Before the database transaction, every `BVF1` file under the old key is decrypted and re-encrypted under the new key into `<name>.rot`, written atomically with mode 0600. Originals are not touched.
   - A file under neither key makes the run refuse before any database change. The refusal names the file and exits 3 (an up-front refusal, as in 3a).
2. **Database.** 3a's single re-encryption transaction runs as before.
3. **Finalise.** Only after the commit is each `.rot` renamed over its original, followed by a directory fsync.
   - If the database transaction did not commit, every `.rot` is deleted and nothing else changes.
4. **Resume.** At startup, after the key check, any `.rot` file whose header key id equals the current key id is renamed over its original. That finishes an interrupted finalise.
   - A `.rot` under any other key id is deleted, because it is staging from a rotation that did not commit.
   - Then, if any `BVF1` file is still under a key id other than the current one, startup refuses. The message names the file and the key id.
5. **Probe.** The wrapper's `--probe` reports, as well as the database answer, how many files are under the old key, under the new key, and as `.rot`. The wrapper's NEW, OLD and NEITHER branches carry on as in 3a. A NEW result also finishes the `.rot` renames.

The rule from 3a still holds: no step ever deletes a key file, or the only valid copy of a file.

## 4. Errors, testing, acceptance

### Errors

| Situation | Result |
|---|---|
| Missing, wrong or conflicting key | Handled by 3a: startup is refused before any file is touched. |
| Snapshot cannot be written | Startup is refused before any file is encrypted. |
| A file cannot be read or written during the migration | Startup is refused, naming the path. The migration resumes on the next start. |
| One damaged file at request time | That request returns 500. Everything else works. |

### Tests

- **Unit:**
  - round trip, including an empty file and a 20 MB file;
  - tampered header, ciphertext, tag or basename each fail;
  - a wrong key fails with `KEY_MISMATCH`;
  - a truncated tag fails;
  - known-answer test for the file subkey.
- **Filesystem, real temp directories:**
  - both upload routes write `BVF1` files, and the serving routes return the original bytes with `no-store`;
  - a plaintext file at rest returns 500;
  - document move, including a name collision and a cross-device fallback simulated by a forced `EXDEV`;
  - the migration is idempotent and resumes after an injected crash, and the snapshot is taken and skipped correctly;
  - missing-document report and the `FILES_ENCRYPTED` event;
  - leftover `.tmp` cleanup;
  - rotation: stage, then commit, then finalise; a database failure deletes the `.rot` files; a crash after the commit is finished at startup; a file under neither key refuses with exit 3.
- **Injection proofs:**
  - remove encryption from one upload route, and a test must fail;
  - remove the basename from the AAD, and the swap test must fail.
- **CI, real Linux Docker** (extends `encryption-key-linux`):
  - upload a photo and a PDF through the API, and check that the raw volume holds only `BVF1` files;
  - seed plaintext files from develop, then upgrade, then check the bytes are equal after decryption and the snapshot exists;
  - rotate, then check both files still display and their header key id is the new one.

### Acceptance criteria

1. **Fresh install.** A raw read of the uploads volume shows only `BVF1` files. Photos and documents display and download normally.
2. **Upgrade from `develop`**, with documents copied out of the old container as the release notes instruct:
   - documents now live on the volume;
   - every file is encrypted, and decrypts to the original bytes;
   - one `FILES_ENCRYPTED` event is written and the snapshot exists;
   - a restart changes nothing.
3. **Missing documents** are listed in the log and in the audit event, and the app still starts.
4. **Rotation** leaves every file under the new key. An interrupted rotation recovers at startup. No file is ever left unreadable.
5. **Nothing else changes:** uploads, display, the image picker, document download and exports. Responses are `no-store`.
6. **CI** is green on Windows and on both time-zone legs. The Linux Docker job proves criteria 1, 2 and 4.

## Known limitations

- Anyone who controls the running server can read every file, as in 3a.
- **Plaintext traces stay on disk.** Plaintext from the original files may remain in free disk blocks after the migration. The app cannot wipe it reliably.
- **Plaintext snapshots.** The snapshots in `backups/uploads-<ts>/` and `.pre-encryption-<ts>/` stay plaintext until they are deleted. Each needs free disk space equal to the size of the uploads folder.
- **No per-item access control.** Any signed-in user can open any file, as today.
- **Files are not in backups.** Uploaded files are still not inside sealed backups (spec 3c).
- **No browser caching.** Photos reload on every visit.
