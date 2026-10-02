# Encrypted Files at Rest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every uploaded photo and document is stored as an encrypted `BVF1` file under a file key derived from the 3a master key. Documents move onto the persistent uploads volume. The upgrade encrypts existing files after taking a snapshot, and rotation re-encrypts files without ever leaving one unreadable.

**Architecture:**
- **Shared crypto.** The format code lives in `src/lib/encryption/core.mjs`: a `file` subkey plus `encryptFile` / `decryptFile` / `isEncryptedFile`.
- **One storage module.** `src/lib/files/storage.ts` owns the uploads root, the legacy documents root, atomic writes, and encrypted reads. Upload and serving routes go through it.
- **Startup step.** `src/lib/files/startup.ts` runs inside `runEncryptionStartup` after 3a's database work. It moves documents, takes a snapshot, encrypts, reports missing files, finishes interrupted rotations, and audits.
- **Rotation.** `scripts/rotate-encryption-key.mjs` stages `.rot` files before the database transaction and finalises them after the commit.

**Tech Stack:** Next.js 16 route handlers, Node `fs/promises` + `node:crypto` (AES-256-GCM, HKDF-SHA256), Prisma 5.22 (SQLite `connection_limit=1` / PostgreSQL 17), Vitest 2, Bash + Windows batch, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-01-encrypted-files-design.md` is binding; decisions D1–D4 are recorded there. It builds on 3a: `docs/superpowers/specs/2026-09-30-field-encryption-design.md`, including that spec's "Changes during implementation".

## Global Constraints

- **File key:** `HKDF-SHA256(master, salt=empty, info="blackvault/file-encryption/v1", 32)`, exposed as `deriveKeys(key).file`.
- **Format:** bytes 0–3 `BVF1`, byte 4 `0x01`, bytes 5–12 the 8-hex-char key id (ASCII), bytes 13–24 a 12-byte IV, then the ciphertext, then a 16-byte GCM tag.
- **AAD and plaintext detection:** the AAD is header bytes 0–12 followed by the UTF-8 basename of the file. A file that does not start with `BVF1` is plaintext.
- **Decryption:** use `createDecipheriv(..., { authTagLength: 16 })`. A key-id mismatch throws `EncryptionKeyError("KEY_MISMATCH")`. A malformed file throws `EncryptionKeyError("MALFORMED")`.
- **Paths:**
  - Uploads root: `IMAGE_UPLOAD_DIR` if set, else `<cwd>/uploads`.
  - Documents: `<uploadsRoot>/documents`.
  - Legacy documents: `<cwd>/storage/uploads/documents`, which only the startup move reads.
  - `Document.fileUrl` is never rewritten.
- **Atomic write:** create `<name>.tmp` empty, `chmod 0600`, write, `fsync` the file, rename it, `fsync` the directory.
- **Responses:** every file response sends `Cache-Control: private, no-store` and keeps the existing security headers.
- **Errors:** after migration, a plaintext file at rest or a decrypt failure returns HTTP 500 with a generic body and an error log that names the file.
- **Excluded from the startup scan:** directories named `.pre-encryption-*`, files ending `.tmp` or `.rot`, and dotfiles.
- **Audit:** the new action `FILES_ENCRYPTED` goes in the `security` group with a non-default `summarize()`. Its `changes` are `{ counts: { images, documents }, moved, missing: [{ id, name }], keyId, snapshot }`.
- **Never** delete a key file, or the only valid copy of an uploaded file.
- **3a rules still apply:**
  - encryption code lives only in `core.mjs`, with types in `core.d.mts`;
  - `BLACKVAULT_` env prefix;
  - stage explicit paths only;
  - never touch `prisma/prisma/dev.db` or the host `dashboard`;
  - never `pkill`, never prune;
  - tests get the fixed key from `vitest.config.ts`.

## Review Focus

1. **A name collision during the document move.** A file with the same name already exists in the new folder. Keep the destination, leave the legacy copy, and log it. Never overwrite. Test owner: Task 3.
2. **Uploads volume on a different filesystem from `/app/storage`.** `rename` fails with `EXDEV`. Copy, fsync, then unlink, and never lose the source on a failed copy. Test owner: Task 3.
3. **Two requests read a file while the startup migration rewrites it.** The app does not serve until `register()` finishes, so a concurrent reader is impossible. Assert that the migration runs inside `runEncryptionStartup`, before serving. Test owner: Task 3.
4. **Image filename basename with odd characters.** The image route builds `${entityId}_${Date.now()}.${ext}`, and a cuid id can include `-`. The AAD basename must match exactly between write and read, so test a round trip through the real upload and serve routes. Test owner: Task 2.
5. **Disk full while writing `.tmp` or `.rot`.** The original must stay intact and the partial file must be cleaned up. Test this with an injected write failure. Test owner: Tasks 2 and 5.

---

### Task 1: File format in the crypto core

**Files:**
- Modify: `src/lib/encryption/core.mjs`, `src/lib/encryption/core.d.mts`, `src/lib/encryption/core.test.ts`

**Interfaces:**
- Produces:
  - `deriveKeys(key)` now returns `{ id, enc, idx, file }`.
  - `FILE_MAGIC = "BVF1"`
  - `isEncryptedFile(buf: Buffer): boolean`
  - `fileKeyId(buf: Buffer): string` throws `MALFORMED`.
  - `encryptFile(keys, basename: string, plaintext: Buffer): Buffer`
  - `decryptFile(keys, basename: string, stored: Buffer): Buffer`

- [ ] **Step 1: Failing tests** (append to `core.test.ts`)

```ts
describe("file encryption", () => {
  const name = "cmh2abc-def_1727000000000.jpg";
  it("round-trips empty, small and 20 MB buffers; header layout", () => {
    for (const size of [0, 17, 20 * 1024 * 1024]) {
      const plain = Buffer.alloc(size, 7);
      const enc = core.encryptFile(keys, name, plain);
      expect(enc.subarray(0, 4).toString("ascii")).toBe("BVF1");
      expect(enc[4]).toBe(1);
      expect(enc.subarray(5, 13).toString("ascii")).toBe(keys.id);
      expect(enc.length).toBe(13 + 12 + size + 16);
      expect(core.isEncryptedFile(enc)).toBe(true);
      expect(core.fileKeyId(enc)).toBe(keys.id);
      expect(core.decryptFile(keys, name, enc).equals(plain)).toBe(true);
    }
  });
  it("plaintext is not BVF1", () => {
    expect(core.isEncryptedFile(Buffer.from("%PDF-1.7"))).toBe(false);
    expect(core.isEncryptedFile(Buffer.alloc(0))).toBe(false);
  });
  it("tampered header, ciphertext, tag, basename, truncated tag all fail", () => {
    const enc = core.encryptFile(keys, name, Buffer.from("hello world"));
    const flip = (i: number) => { const b = Buffer.from(enc); b[i] ^= 1; return b; };
    expect(() => core.decryptFile(keys, name, flip(4))).toThrow();      // version
    expect(() => core.decryptFile(keys, name, flip(20))).toThrow();     // iv
    expect(() => core.decryptFile(keys, name, flip(26))).toThrow();     // ciphertext
    expect(() => core.decryptFile(keys, name, flip(enc.length - 1))).toThrow(); // tag
    expect(() => core.decryptFile(keys, "other.jpg", enc)).toThrow();
    expect(() => core.decryptFile(keys, name, enc.subarray(0, enc.length - 12))).toThrow();
  });
  it("wrong key is KEY_MISMATCH; short buffer is MALFORMED", () => {
    const other = core.deriveKeys(core.parseKeyHex("b".repeat(64)));
    const enc = core.encryptFile(keys, name, Buffer.from("x"));
    expect(() => core.decryptFile(other, name, enc)).toThrow(expect.objectContaining({ code: "KEY_MISMATCH" }));
    expect(() => core.decryptFile(keys, name, Buffer.from("BVF1"))).toThrow(expect.objectContaining({ code: "MALFORMED" }));
  });
  it("file subkey is independent and pinned (known answer)", () => {
    expect(keys.file.equals(keys.enc)).toBe(false);
    expect(keys.file.equals(keys.idx)).toBe(false);
    // Implementer: compute once with a standalone node one-liner (hkdfSync sha256, key=a*64 hex,
    // salt empty, info "blackvault/file-encryption/v1", 32) and pin the full hex here.
    expect(keys.file.toString("hex")).toBe(KNOWN_FILE_SUBKEY_HEX);
  });
});
```

Define `KNOWN_FILE_SUBKEY_HEX` as a constant at the top of the new `describe` block, computed independently as the comment says. The controller re-computes it to check.

- [ ] **Step 2:** Run `timeout 300 npx vitest run src/lib/encryption/core.test.ts` and confirm it FAILS.

- [ ] **Step 3: Implement** in `core.mjs`

```js
export const FILE_MAGIC = "BVF1";
const FILE_VERSION = 1;
const FILE_HEADER_LEN = 13; // magic(4) + version(1) + keyId(8)
const FILE_IV_LEN = 12;
const FILE_TAG_LEN = 16;

// in deriveKeys(): add  file: subkey(key, "blackvault/file-encryption/v1"),

function fileHeader(id) {
  return Buffer.concat([Buffer.from(FILE_MAGIC, "ascii"), Buffer.from([FILE_VERSION]), Buffer.from(id, "ascii")]);
}
function fileAad(header, basename) {
  return Buffer.concat([header, Buffer.from(String(basename), "utf8")]);
}
export function isEncryptedFile(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === FILE_MAGIC;
}
export function fileKeyId(buf) {
  if (!isEncryptedFile(buf) || buf.length < FILE_HEADER_LEN + FILE_IV_LEN + FILE_TAG_LEN || buf[4] !== FILE_VERSION) {
    throw new EncryptionKeyError("MALFORMED", "Not a BVF1 encrypted file.");
  }
  return buf.subarray(5, FILE_HEADER_LEN).toString("ascii");
}
export function encryptFile(keys, basename, plaintext) {
  const header = fileHeader(keys.id);
  const iv = randomBytes(FILE_IV_LEN);
  const c = createCipheriv("aes-256-gcm", keys.file, iv, { authTagLength: FILE_TAG_LEN });
  c.setAAD(fileAad(header, basename));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([header, iv, ct, c.getAuthTag()]);
}
export function decryptFile(keys, basename, stored) {
  const id = fileKeyId(stored);
  if (id !== keys.id) {
    throw new EncryptionKeyError("KEY_MISMATCH", `File was encrypted with key ${id}, current key is ${keys.id}.`);
  }
  const header = stored.subarray(0, FILE_HEADER_LEN);
  const iv = stored.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + FILE_IV_LEN);
  const tag = stored.subarray(stored.length - FILE_TAG_LEN);
  const ct = stored.subarray(FILE_HEADER_LEN + FILE_IV_LEN, stored.length - FILE_TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", keys.file, iv, { authTagLength: FILE_TAG_LEN });
  d.setAAD(fileAad(header, basename));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
```

Update `core.d.mts`:
- add `file: Buffer` to `FieldKeys`;
- declare the new exports;
- keep the error-code unions as they are, since `MALFORMED` and `KEY_MISMATCH` already exist.

Any `FieldKeys` objects that are built by hand in tests or scripts, for example the mirrored code in `scripts/rotate-encryption-key.mjs`, must still typecheck. Grep for `deriveKeys(` and `FieldKeys` to find them.

- [ ] **Step 4:** Tests PASS. Typecheck stays within the baseline, and lint reports 0 errors.
- [ ] **Step 5: Injection proof.** Remove the basename from `fileAad`, confirm the basename-swap assertion FAILS, then restore.
- [ ] **Step 6: Commit** with `git commit -m "feat(files): BVF1 file format and file subkey in the crypto core"`.

---

### Task 2: Storage module, upload routes, serving routes

**Files:**
- Create: `src/lib/files/storage.ts`, `src/lib/files/storage.test.ts`
- Modify:
  - `src/lib/upload-security.ts`: `getCanonicalUploadsRoot` and `resolveDocumentStoragePath` resolve under `documentsRoot()`. Keep the old path only as `legacyDocumentsRoot()`.
  - `src/app/api/documents/upload/route.ts`
  - `src/app/api/images/upload/route.ts`
  - `src/app/uploads/[...path]/route.ts`
  - `src/app/api/files/documents/[fileName]/route.ts`
  - `src/app/api/images/library/route.ts` (listing only: it must skip `.tmp`, `.rot` and `.pre-encryption-*` entries)
  - `src/app/api/images/delete/route.ts`, if it resolves its own root (use `uploadsRoot()`)
- Tests: the existing route tests next to each route, plus a real-filesystem test that drives each upload route followed by its serving route.

**Interfaces:**
- Consumes: from Task 1, `encryptFile`, `decryptFile`, `isEncryptedFile`; from 3a, `getFieldKeys()` in `src/lib/encryption/keys.ts`.
- Produces, in `storage.ts`:
  - `uploadsRoot(env = process.env): string`
  - `documentsRoot(env?): string`
  - `legacyDocumentsRoot(cwd = process.cwd()): string`
  - `writeEncryptedFile(absPath: string, plaintext: Buffer): Promise<void>`: atomic, mode 0600
  - `writeAtomic(absPath: string, bytes: Buffer): Promise<void>`: the shared tmp/fsync/rename/dir-fsync primitive
  - `readDecryptedFile(absPath: string): Promise<Buffer>`. It throws `FileAtRestError` with `code: "PLAINTEXT_AT_REST" | "DECRYPT_FAILED"` and a `path`.
  - `fileResponseHeaders(contentType: string): Headers`: `Cache-Control: private, no-store` plus the existing security headers.

- [ ] **Step 1: Failing tests.**
  - `writeEncryptedFile` produces a `BVF1` file with mode 600 and leaves no `.tmp` file behind.
  - Review Focus 5: an injected write failure keeps the original intact and leaves no `.tmp`. Use a `vi.spyOn` on the `fs/promises` handle's `write`, or write into a read-only directory.
  - `readDecryptedFile` returns the original bytes.
  - Plaintext on disk gives `PLAINTEXT_AT_REST`.
  - A corrupted byte gives `DECRYPT_FAILED`.
  - `uploadsRoot` honours `IMAGE_UPLOAD_DIR`.
  - `documentsRoot()` is `<uploadsRoot>/documents`.
  - Route tests:
    - The document upload route writes `BVF1` under `documentsRoot()`, and the stored `fileUrl` is unchanged in shape.
    - The image upload route writes `BVF1`.
    - Both serving routes return the original bytes with `Cache-Control: private, no-store`, and still send `X-Content-Type-Options` and the other existing headers.
    - A plaintext file at rest gives 500 with a generic body.
    - Review Focus 4: a cuid with `-` and `_` survives an end-to-end upload then serve, through the real handlers on a temp `IMAGE_UPLOAD_DIR`.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement.
  - Routes keep their validation as it is: magic bytes, size, type, auth, rate limits.
  - Routes hand the validated buffer to `writeEncryptedFile`, never to `fs.writeFile`.
  - Serving routes call `readDecryptedFile` and map `FileAtRestError` to 500 plus `console.error` with the path and code.
- [ ] **Step 4:** The tests pass. Run the full `npm test` with `timeout 900`, plus typecheck and lint.
- [ ] **Step 5: Injection proof.** Make the image upload route call `fs.writeFile` with plaintext. A test must fail. Restore.
- [ ] **Step 6: Commit** with `git commit -m "feat(files): uploads are written encrypted and served decrypted, no-store"`.

---

### Task 3: Startup — move documents, snapshot, encrypt, report missing, finish rotations, audit

**Files:**
- Create: `src/lib/files/startup.ts`, `src/lib/files/startup.real-fs.test.ts`
- Modify:
  - `src/lib/encryption/startup.ts`: call the file step from `runEncryptionStartup`, after the database migration and compaction, before returning.
  - `src/lib/audit/actions.ts`, `src/lib/audit/query.ts` (`SECURITY_ACTIONS`), `src/lib/audit/summary.ts`, and their tests.

**Interfaces:**
- Consumes:
  - from Task 1, `encryptFile`, `isEncryptedFile`, `fileKeyId`;
  - from Task 2, `uploadsRoot`, `documentsRoot`, `legacyDocumentsRoot`, `writeAtomic`;
  - from 3a, `getFieldKeys`, `createRawPrismaClient`, `writeAuditEvent` (`src/lib/audit/record.ts`), and the host-path helper from `src/lib/encryption/pre-encryption-snapshot.ts` (`hostPathOf`).
- Produces:
  - `runFileStartup(raw: RawClient, opts?: { now?: Date; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<FileStartupResult>`
  - `FileStartupResult = { moved: number; counts: { images: number; documents: number }; missing: { id: string; name: string }[]; snapshot: string | null; finishedRotations: number }`

**Order inside `runFileStartup`:**
1. Delete leftover `*.tmp` files.
2. Resolve `.rot` files, using the current key id:
   - a `.rot` file whose header key id is the current one is renamed over its original;
   - any other `.rot` file is deleted.
3. Move legacy documents.
4. Snapshot, but only if plaintext exists and the update-script marker is absent. The marker is the env `BLACKVAULT_UPLOADS_SNAPSHOT` (a path), set by Task 4.
5. Encrypt every plaintext file.
6. Refuse to start if any `BVF1` file has a key id other than the current one. The message names the file.
7. Report missing documents (`Document` rows whose resolved file does not exist).
8. Write a `FILES_ENCRYPTED` audit event when anything changed.

- [ ] **Step 1: Failing tests** (real temp directories; SQLite `connection_limit=1` for the Document rows):
  - Fresh state with no files: nothing happens and no event is written.
  - Legacy documents are moved to the new root and then encrypted.
  - Review Focus 1, name collision: the destination is kept, the legacy file stays, and a log line is written.
  - Review Focus 2: a forced `EXDEV` on `rename` (`vi.spyOn(fs, "rename")`) falls back to copy, fsync, unlink. A copy failure leaves the source intact.
  - The snapshot directory exists with mode 700, its files are mode 600, it holds the plaintext bytes, and the scan skips it.
  - With `BLACKVAULT_UPLOADS_SNAPSHOT` set, no snapshot is taken.
  - A snapshot failure (read-only target) refuses to start, and no file is encrypted.
  - The step is idempotent: a second run changes nothing and writes no event.
  - Resume after a crash: throw on the third file and check the first two are encrypted and the rest plaintext; the next run finishes the job.
  - A `.rot` under the current key is finalised. A `.rot` under another key is deleted.
  - A `BVF1` file under a foreign key id refuses to start.
  - Two missing documents are logged by id and name and appear in `changes.missing`, and the app still starts.
  - `FILES_ENCRYPTED` counts are correct, and the partition and summary exhaustiveness tests pass with the new action.
  - Review Focus 3: `runEncryptionStartup` calls `runFileStartup` before resolving. Assert the call order with a spy.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement. **Step 4:** Make them PASS, then run the full `npm test`, typecheck and lint.
- [ ] **Step 5: Injection proof.** Skip the plaintext scan for `documents/`. A test must fail. Restore.
- [ ] **Step 6: Commit** with `git commit -m "feat(files): startup moves documents, snapshots, encrypts existing files, reports missing ones"`.

---

### Task 4: Update scripts snapshot the uploads folder

**Files:**
- Modify: `scripts/db-snapshot.sh`, `scripts/db-snapshot.bat`, `docker-compose.yml` (pass `BLACKVAULT_UPLOADS_SNAPSHOT` through, empty by default), `docker-compose.dev.yml`
- Tests: `scripts/installers-encryption.test.ts` (or the closest existing snapshot test) and `scripts/ci/windows/Test-WindowsInstallers.ps1`

**Interfaces:**
- Produces: `backups/uploads-<YYYYmmdd-HHMMSS>/`, a copy of `${DATA_DIR}/uploads` with directories at mode 700 and files at mode 600. Each file is created empty and chmod'ed before its contents are written, following the 3a rule. The scripts export `BLACKVAULT_UPLOADS_SNAPSHOT=<container-visible marker>` into the next `up`, so that the app skips its own snapshot.

- [ ] **Step 1: Failing tests.**
  - The snapshot copies a seeded uploads tree byte-for-byte, with the modes above.
  - A failed copy exits non-zero, and the update stops.
  - The marker reaches the container environment.
  - The same three checks pass in the Windows harness scenario.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement. **Step 4:** Make them PASS, then run shellcheck and lint.
- [ ] **Step 5: Injection proof.** Ignore the copy failure. A test must fail. Restore.
- [ ] **Step 6: Commit** with `git commit -m "feat(files): update scripts snapshot the uploads folder before upgrading"`.

---

### Task 5: Rotation re-encrypts files safely

**Files:**
- Modify: `scripts/rotate-encryption-key.mjs`, `scripts/rotate-encryption-key.test.ts`, `rotate-key.sh`, `rotate-key.bat`, `scripts/ci/windows/Test-WindowsInstallers.ps1`

**Interfaces:**
- Consumes: from Task 1, `encryptFile`, `decryptFile`, `fileKeyId` (imported from `core.mjs`; no new crypto code).
- The uploads root resolves the same way as in Task 2. Mirror that logic in the `.mjs` and add an equality test against `uploadsRoot()`, following the 3a mirroring rule.
- Produces: `--probe` output gains a second line `FILES old=<n> new=<n> rot=<n>`. The first line stays exactly `OLD|NEW|NEITHER`, so existing parsers keep working.

**Steps:**
1. Before the database transaction, stage every `BVF1` file under the old key as `<name>.rot` under the new key, written atomically.
   - A file under neither key refuses the rotation up front, with exit code 3, and names the file.
2. Run the database transaction as in 3a.
3. After the commit, rename each `.rot` file over its original and fsync the directory.
4. If the run fails before the commit, delete all `.rot` files.
5. Wrappers: when the probe returns NEW, finish any leftover `.rot` renames before the swap.

- [ ] **Step 1: Failing tests** (SQLite, plus Postgres when `ENCRYPTION_REAL_DB_PG_URL` is set):
  - After rotation every file has the new key id and decrypts to the original bytes, and no `.rot` files remain.
  - A database failure before commit leaves the originals untouched and deletes every `.rot`.
  - A crash after commit, before finalise (inject an exit), leaves `.rot` files under the new key. `runFileStartup` from Task 3 then finalises them.
  - A file under neither key refuses with exit 3, and nothing changes.
  - Review Focus 5: a disk-full injection while writing a `.rot` leaves the original intact and the run refuses.
  - The probe line reports correct counts.
  - The uploads-root mirror test passes.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement. **Step 4:** Make them PASS. Run shellcheck and lint, and add Windows harness scenarios for the probe `FILES` line and for finishing leftover renames.
- [ ] **Step 5: Injection proof.** Rename the `.rot` files BEFORE the database commit. The crash-after-commit test must then show that a database rollback leaves files unreadable, so the test fails. Restore.
- [ ] **Step 6: Commit** with `git commit -m "feat(files): rotation stages .rot files before the database commit and finalises after"`.

---

### Task 6: CI on real Linux Docker, docs, release notes

**Files:**
- Modify: `scripts/ci/encryption-key-linux.sh` (or the job's script), `.github/workflows/ci.yml` if needed, `README.md`, `CONTRIBUTING.md`, the 3b spec (append a "Changes during implementation" section if anything deviated), `docs/release-checklist.md`

**CI must prove the following on `ubuntu-latest`:**
1. A real image is built from this branch.
2. Uploading a photo and a PDF through the API leaves only `BVF1` files under the uploads volume (`head -c4`).
3. Plaintext files and a legacy document are seeded inside `/app/storage/uploads/documents` of a develop-built (663523c or ebdbf36) container, which is then upgraded following the README's documented `docker cp` rescue step. After the upgrade:
   - the files decrypt to the same bytes, checked by sha256 through the serving routes;
   - the snapshot exists with mode 600 and owner 1001;
   - exactly one `FILES_ENCRYPTED` event exists.
4. `rotate-key.sh` runs, the files carry the new key id, and both still serve.

**Docs:**
- **README:**
  - what is encrypted now (files too);
  - the one-time document rescue command, run BEFORE upgrading;
  - the missing-documents report;
  - the snapshot folders and the disk space they need, plus `sudo` to delete;
  - `no-store` caching;
  - plaintext remnants in free disk blocks;
  - files are not in backups yet (3c).
- **CONTRIBUTING:** new upload code must use `writeEncryptedFile` and `readDecryptedFile`, never `fs.writeFile`/`fs.readFile` on the uploads root. Add a guard test that greps `src/app` for `fs.writeFile`/`writeFileSync` near `uploads`, or ban them in route files under `api/*upload*`.
- **Verify** every sentence against the code, and list `file:line` for each claim in the report.

- [ ] **Step 1:** Add the guard test and the CI steps. **Step 2:** Push, then iterate until CI is green. **Step 3:** Write the docs. **Step 4:** Run the full `npm test`, typecheck, lint, and `npm run build` with no key. **Step 5: Commit** with `git commit -m "docs+ci(files): encrypted uploads documented and proven on real Docker"`.

---

### Task 7: Whole-branch verification and PR

- [ ] **Step 1:** Run lint, typecheck, `npm test` three times, and `npm run build`, and record the counts.
- [ ] **Step 2: Fresh install on a real image** (resources prefixed `bvfiles-t7-`):
  - upload photos and documents;
  - read the raw volume and check every file is `BVF1`;
  - the UI shows images and documents download;
  - response headers include `no-store`;
  - rotate, and everything still serves under the new key id.
- [ ] **Step 3: Upgrade from `develop` (ebdbf36)** on SQLite and on Postgres, with plaintext images and documents. Follow the README exactly, including the document rescue. Then check:
  - every file is encrypted, and each sha256 is identical through the serving routes;
  - the snapshot is taken;
  - one `FILES_ENCRYPTED` event;
  - missing documents are reported when the rescue step is skipped on purpose;
  - a restart changes nothing.
- [ ] **Step 4:** Build an acceptance table mapping the spec's 6 criteria to evidence.
- [ ] **Step 5:** Open the PR with `gh pr create --repo doomcrewinc/BlackVaultArmory --base develop`. The body has the summary, the acceptance table and the known limitations, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Mark it ready once CI is green (the user has allowed `gh pr edit` and `gh pr ready`). Never merge.
- [ ] **Step 6:** CI is green on the final head. Report the run URL.
