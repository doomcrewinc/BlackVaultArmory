import { promises as fsp } from "node:fs";
import path from "node:path";
import { decryptFile, encryptFile, isEncryptedFile } from "../encryption/core.mjs";
import { getFieldKeys } from "../encryption/keys";

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
 * Creates `<absPath>.tmp` empty with mode 0600, writes `bytes`, fsyncs the
 * file, renames it over `absPath`, then fsyncs the directory. On any failure
 * the `.tmp` file is removed and the original at `absPath` (if any) is left
 * untouched — the rename only happens once the write below it has fully
 * succeeded.
 */
export async function writeAtomic(absPath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(absPath);
  const tmpPath = `${absPath}.tmp`;

  const handle = await fsp.open(tmpPath, "w", 0o600);
  try {
    try {
      // Created empty then chmodded then written — a lesson from 3a about
      // default ACLs overriding the creation mode (pre-encryption-snapshot.ts).
      await handle.chmod(0o600);
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }

  await fsp.rename(tmpPath, absPath);

  const dirHandle = await fsp.open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
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

  constructor(code: "PLAINTEXT_AT_REST" | "DECRYPT_FAILED", filePath: string, cause?: unknown) {
    super(`Cannot read ${filePath}: ${code}`, cause !== undefined ? { cause } : undefined);
    this.name = "FileAtRestError";
    this.code = code;
    this.path = filePath;
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
