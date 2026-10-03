import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { createBackupOpener } from "@/lib/encryption/core.mjs";
import { MAX_MANIFEST_BYTES, parseManifest, type Manifest } from "./manifest";
import { readTar } from "./tar";

/**
 * `--verify` (spec 3c §2): stream-decrypts a whole `.bvb` archive and checks
 * its contents against its own manifest. Nothing is written to disk.
 *
 * The BVB1 layer (core.mjs's opener) already proves every byte came from
 * someone holding the passphrase and that the stream is complete and in
 * order. This module proves the archive is internally CONSISTENT — that what
 * a restore would unpack is exactly what the manifest promises:
 * - only `db.json`, `manifest.json` and `files/...` entries exist;
 * - `manifest.json` is present, within MAX_MANIFEST_BYTES, valid, and the
 *   LAST entry (the engine writes it last so it can hash files while
 *   streaming them — controller ruling, see ./manifest.ts);
 * - the set of `files/...` entries equals `manifest.files` exactly (none
 *   extra, none missing), and each one's size and sha256 match;
 * - `db.json` parses and holds exactly `manifest.counts` rows per model.
 *
 * File entries arrive BEFORE the manifest, so each is hashed as it streams
 * past and only its (size, sha256) is kept; the comparison happens once the
 * manifest has been read. Memory is one tar chunk plus one small record per
 * file — plus `db.json`, which is read whole (the engine holds it in memory
 * too; it is small next to the files).
 */

export class FullBackupVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FullBackupVerifyError";
  }
}

export interface VerifyProgress {
  /** File entries hashed so far, and their total plaintext size. */
  filesDone: number;
  bytesDone: number;
}

export interface VerifyOptions {
  onProgress?: (progress: VerifyProgress) => void;
}

export interface VerifyResult {
  /** Number of uploaded files in the archive (`manifest.files.length`). */
  files: number;
  /** Total plaintext size of those files, in bytes. */
  bytes: number;
  /** Size of the `.bvb` file itself, in bytes. */
  archiveBytes: number;
  manifest: Manifest;
}

const DB_ENTRY = "db.json";
const MANIFEST_ENTRY = "manifest.json";
const FILES_PREFIX = "files/";

function fail(message: string): never {
  throw new FullBackupVerifyError(`Backup verification failed: ${message}`);
}

async function readWhole(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function hashBody(body: Readable): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

/** `db.json` must parse and hold exactly `counts` rows per model. Shared with the restore engine (./full-restore.ts). */
export function checkDbAgainstCounts(dbBytes: Buffer, counts: Record<string, number>): void {
  let db: unknown;
  try {
    db = JSON.parse(dbBytes.toString("utf8"));
  } catch {
    fail("db.json is not valid JSON.");
  }
  if (typeof db !== "object" || db === null || Array.isArray(db)) fail("db.json is not a JSON object.");
  const record = db as Record<string, unknown>;
  for (const [key, expected] of Object.entries(counts)) {
    const rows = record[key];
    if (!Array.isArray(rows)) fail(`db.json has no "${key}" records, but the manifest counts ${expected}.`);
    if (rows.length !== expected) fail(`db.json holds ${rows.length} "${key}" records, but the manifest counts ${expected}.`);
  }
}

/**
 * The set of `files/...` entries read from the archive must equal
 * `manifest.files` exactly — none missing, none extra — and each one's size
 * and sha256 must match. Returns the files' total plaintext size. Shared with
 * the restore engine (./full-restore.ts), which runs the same comparison on
 * what it staged before it changes anything.
 */
export function checkEntriesAgainstManifest(seen: ReadonlyMap<string, { size: number; sha256: string }>, manifest: Manifest): number {
  const listed = new Set<string>();
  let bytes = 0;
  for (const entry of manifest.files) {
    listed.add(entry.path);
    const actual = seen.get(entry.path);
    if (!actual) fail(`${entry.path} is listed in the manifest but missing from the archive.`);
    if (actual.size !== entry.size) {
      fail(`${entry.path} has the wrong size (${actual.size} bytes, the manifest records ${entry.size}).`);
    }
    if (actual.sha256 !== entry.sha256) {
      fail(`${entry.path} does not match its recorded checksum (sha256). The backup is damaged.`);
    }
    bytes += entry.size;
  }
  for (const entryPath of seen.keys()) {
    if (!listed.has(entryPath)) fail(`${entryPath} is in the archive but not listed in the manifest.`);
  }
  return bytes;
}

/**
 * Verifies the archive at `file`. Resolves with what it holds; rejects with
 * - `SealError` (core.mjs) — wrong passphrase, damaged, truncated or
 *   unsupported archive. Its `message` is the user-facing text: a cut in the
 *   middle of a later chunk reports code WRONG_PASSPHRASE_OR_DAMAGED with a
 *   "damaged or incomplete" message, so callers must show the message, not
 *   map the code;
 * - `FullBackupVerifyError` / `ManifestError` — the archive decrypts but its
 *   contents and manifest disagree;
 * - a tar error (`tar: ...`) or the fs error (ENOENT, EACCES) as-is.
 */
export async function verifyFullBackup(file: string, passphrase: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const archiveBytes = (await fsp.stat(file)).size;
  const opener = createBackupOpener(passphrase);
  const input = createReadStream(file);
  // Callback form: an fs error destroys the opener with that error, and a
  // readTar rejection (which destroys the opener) closes the file. The
  // outcome itself is reported by readTar below.
  pipeline(input, opener, () => undefined);

  const seen = new Map<string, { size: number; sha256: string }>();
  let dbBytes: Buffer | null = null;
  let manifest: Manifest | null = null;
  let bytesDone = 0;

  await readTar(opener, async (entryPath, size, body) => {
    if (manifest) fail(`"${entryPath}" comes after manifest.json, which must be the last entry.`);
    if (entryPath === MANIFEST_ENTRY) {
      // Checked against the DECLARED size, before a single byte is buffered.
      if (size > MAX_MANIFEST_BYTES) fail(`manifest.json is too large (${size} bytes).`);
      manifest = parseManifest(await readWhole(body));
      return;
    }
    if (entryPath === DB_ENTRY) {
      dbBytes = await readWhole(body);
      return;
    }
    if (!entryPath.startsWith(FILES_PREFIX)) fail(`unexpected entry "${entryPath}" in the archive.`);
    const hashed = await hashBody(body);
    seen.set(entryPath, hashed);
    bytesDone += hashed.size;
    opts.onProgress?.({ filesDone: seen.size, bytesDone });
  });

  // Only now is the stream known to be complete (the opener ended cleanly).
  const m = manifest as Manifest | null;
  if (!m) fail("the archive has no manifest.json.");
  if (!dbBytes) fail("the archive has no db.json.");

  const bytes = checkEntriesAgainstManifest(seen, m);

  checkDbAgainstCounts(dbBytes, m.counts);

  return { files: m.files.length, bytes, archiveBytes, manifest: m };
}
