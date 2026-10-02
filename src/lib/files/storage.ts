import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { decryptFile, encryptFile, isEncryptedFile } from "../encryption/core.mjs";
import { getFieldKeys } from "../encryption/keys";

/** Directory-fsync failures that Windows raises instead of succeeding. The
 * rename has already landed by the time this runs, so these are tolerated:
 * the write is durable at the file level even when the directory entry's
 * own durability can't be confirmed on that platform. */
const DIR_FSYNC_TOLERATED_CODES = new Set(["EPERM", "EISDIR", "EINVAL"]);

/**
 * Writes every byte of `bytes` to `handle`, looping on `write(2)`'s own
 * short-write behaviour (fix round 1, I1). A single `handle.write(bytes)`
 * issues exactly one `write(2)`, which POSIX allows to return fewer bytes
 * than asked for without raising an error — most realistically when a disk
 * genuinely runs out of space partway through. The old code trusted that
 * one call to have written everything, fsynced and renamed the short
 * result over the original, and reported success. `handle.writeFile()`
 * also loops internally, but it calls into Node's C++ binding directly
 * rather than through `handle.write()`, so nothing here can observe or
 * inject a short write through it in a test — hence the explicit loop. A
 * call that makes no forward progress (`bytesWritten === 0`) throws rather
 * than spin forever; a real full disk raises an error (commonly `ENOSPC`)
 * on the next attempt well before that could happen.
 */
async function writeFull(handle: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
    if (bytesWritten <= 0) {
      throw new Error("writeAtomic: write() made no forward progress (0 bytes written)");
    }
    written += bytesWritten;
  }
}

/**
 * Encrypted files at rest (spec 3b,
 * docs/superpowers/specs/2026-10-01-encrypted-files-design.md §1-§2).
 *
 * The one place that knows where uploaded files live on disk and how they
 * are written/read as BVF1 (src/lib/encryption/core.mjs). Both upload routes
 * and both serving routes go through this module; neither ever calls
 * fs.writeFile/fs.readFile on an upload directly.
 *
 * Imports stay relative (no `@/`): scripts (the startup migration, rotation)
 * load this under plain ts-node, which has no path aliases, same rule as
 * src/lib/encryption/keys.ts.
 *
 * fsp.* is always called through the imported namespace object (never
 * destructured into bare function references) so that tests can
 * `vi.spyOn(fsp, "open")` — or spy on the handle `open` returns — and have
 * it take effect here too, since both this module and the test share the
 * same `node:fs` promises object.
 */

/** `IMAGE_UPLOAD_DIR` when set, else `<cwd>/uploads`. The one uploads root. */
export function uploadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.IMAGE_UPLOAD_DIR ? path.resolve(env.IMAGE_UPLOAD_DIR) : path.join(process.cwd(), "uploads");
}

/** `<uploadsRoot>/documents`. `Document.fileUrl` never changes shape; only this root does. */
export function documentsRoot(env?: NodeJS.ProcessEnv): string {
  return path.join(uploadsRoot(env), "documents");
}

/**
 * The pre-3b documents location, `<cwd>/storage/uploads/documents`. Read only
 * by the startup move step (spec §2, step 1) — nothing else should write
 * here again.
 */
export function legacyDocumentsRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, "storage", "uploads", "documents");
}

/**
 * The shared tmp/fsync/rename/dir-fsync primitive (spec §1, "Atomic writes").
 * Creates `<absPath>.<8 random hex>.tmp` empty with mode 0600 (fix round 1,
 * I2: a FIXED `<absPath>.tmp` name let two concurrent writers to the same
 * target corrupt each other, and let a pre-planted `.tmp` symlink be
 * followed; the random suffix plus `"wx"` — create-exclusive, refuses an
 * existing path including a symlink — close both. The name still ends in
 * `.tmp`, so Task 3's startup sweep for leftover `*.tmp` files still matches
 * it), writes `bytes` (fully — fix round 1, I1: `writeFull` above retries
 * until every byte lands, since a single `handle.write` only issues one
 * `write(2)` and can silently install a short/truncated file when the
 * underlying write returns fewer bytes than asked without erroring), fsyncs
 * the file, renames it over `absPath`, then fsyncs the directory. On any
 * failure up to and including the rename, the `.tmp` file is removed (fix
 * round 1, m2: a failed rename used to leave an orphaned `.tmp`) and the
 * original at `absPath` (if any) is left untouched. A directory-fsync
 * failure with a code Windows is known to raise instead of succeeding (fix
 * round 1, m8) is tolerated: the rename already landed, so the write itself
 * is not lost.
 */
export async function writeAtomic(absPath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(absPath);
  const tmpPath = `${absPath}.${randomBytes(4).toString("hex")}.tmp`;

  const handle = await fsp.open(tmpPath, "wx", 0o600);
  try {
    try {
      // Created empty then chmodded then written — a lesson from 3a about
      // default ACLs overriding the creation mode (pre-encryption-snapshot.ts).
      await handle.chmod(0o600);
      await writeFull(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }

  try {
    await fsp.rename(tmpPath, absPath);
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }

  try {
    const dirHandle = await fsp.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (!code || !DIR_FSYNC_TOLERATED_CODES.has(code)) {
      throw e;
    }
  }
}

/**
 * Encrypts `plaintext` under the current file key and writes it atomically
 * to `absPath`. Routes hand their validated upload buffer here — never to
 * `fs.writeFile` — so no plaintext file is ever written.
 */
export async function writeEncryptedFile(absPath: string, plaintext: Buffer): Promise<void> {
  const keys = getFieldKeys();
  const basename = path.basename(absPath);
  const encrypted = encryptFile(keys, basename, plaintext);
  await writeAtomic(absPath, encrypted);
}

/**
 * `readDecryptedFile`'s failure, with the path named so the caller's error
 * log (and never the HTTP response body) can say which file was bad.
 *
 * - PLAINTEXT_AT_REST: the file on disk does not start with `BVF1`. After
 *   the startup migration this means a write path bypassed encryption.
 * - DECRYPT_FAILED: the file is BVF1 but failed to decrypt — wrong key,
 *   tampered bytes, or any other error core.mjs's decryptFile throws (M6:
 *   a GCM auth failure throws a plain Error with no `code`; it is caught
 *   here like every other decryptFile failure, never left to bubble up as
 *   an unhandled 500).
 */
export class FileAtRestError extends Error {
  readonly code: "PLAINTEXT_AT_REST" | "DECRYPT_FAILED";
  readonly path: string;
  /**
   * The underlying decryptFile failure's own code — `KEY_MISMATCH` or
   * `MALFORMED` (EncryptionKeyError) — or `AUTH_FAILED` for a GCM
   * authentication failure, which throws a plain, code-less `Error` (M6).
   * Fix round 1, m3: the serving routes' log line used to name only
   * `DECRYPT_FAILED`, dropping exactly the detail that would tell Task 5
   * apart an interrupted rotation (KEY_MISMATCH) from tampering
   * (AUTH_FAILED). `undefined` when `code` is `PLAINTEXT_AT_REST`, since
   * that case has no decrypt failure to name.
   */
  readonly causeCode: string | undefined;

  constructor(code: "PLAINTEXT_AT_REST" | "DECRYPT_FAILED", filePath: string, cause?: unknown) {
    super(`Cannot read ${filePath}: ${code}`, cause !== undefined ? { cause } : undefined);
    this.name = "FileAtRestError";
    this.code = code;
    this.path = filePath;
    this.causeCode =
      code === "DECRYPT_FAILED"
        ? typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string"
          ? (cause as { code: string }).code
          : "AUTH_FAILED"
        : undefined;
  }
}

/**
 * Reads `absPath` and returns the decrypted plaintext. Throws FileAtRestError
 * (never a bare Error, never letting fs's own ENOENT/etc. be confused with a
 * crypto failure) for anything wrong with the file's encryption state; an
 * fs-level error such as ENOENT from the initial read propagates as-is so
 * callers can still tell "missing" from "damaged".
 */
export async function readDecryptedFile(absPath: string): Promise<Buffer> {
  const stored = await fsp.readFile(absPath);
  if (!isEncryptedFile(stored)) {
    throw new FileAtRestError("PLAINTEXT_AT_REST", absPath);
  }
  const keys = getFieldKeys();
  const basename = path.basename(absPath);
  try {
    return decryptFile(keys, basename, stored);
  } catch (e) {
    throw new FileAtRestError("DECRYPT_FAILED", absPath, e);
  }
}

/**
 * Headers for every decrypted file response: never cached (D4), plus the
 * security headers the serving routes already sent.
 */
export function fileResponseHeaders(contentType: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Disposition", "inline");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return headers;
}
