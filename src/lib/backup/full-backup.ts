import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { recordEventBestEffort } from "@/lib/audit/events";
import { createBackupSealer } from "@/lib/encryption/core.mjs";
import { getFieldKeys } from "@/lib/encryption/keys";
import { snapshotStamp } from "@/lib/encryption/pre-encryption-snapshot";
import { FileAtRestError, readDecryptedFile, uploadsRoot } from "@/lib/files/storage";
import { APP_VERSION } from "@/lib/version";
import { acquireFullBackupLock, DEFAULT_FULL_BACKUP_DIR } from "./full-lock";
import { verifyFullBackup } from "./full-verify";
import { buildManifest, type ManifestFileEntry, type ManifestSkippedEntry } from "./manifest";
import { backupCounts, buildBackupPayload, collectBackupRecords } from "./records";
import { TarWriter } from "./tar";

/**
 * The full-backup engine (spec 3c §2): one passphrase-sealed `.bvb` archive
 * holding the database records and every uploaded file, decrypted, so it can
 * be restored onto an install with a DIFFERENT encryption key.
 *
 * This is the only code that creates full backups. Both entry points call
 * `runFullBackup`: the CLI (`scripts/entry/full-backup.ts`, bundled to
 * `dist/scripts/full-backup.mjs`, run by `backup.sh`) and the Settings
 * button's in-process job. They share one lock (./full-lock.ts).
 *
 * What a run does, in order:
 * 1. checks the backup folder is writable (the error names the folder);
 * 2. takes the lock (FullBackupAlreadyRunningError if a backup is running);
 * 3. reads every backup model through the app client (decrypted) and lists
 *    the uploads on disk;
 * 4. streams a ustar tar — `db.json`, then `files/...`, then `manifest.json`
 *    LAST — through the BVB1 sealer into `<name>.partial` (created empty,
 *    chmod 0600, then written). The manifest is last (controller ruling,
 *    overriding the spec's "first") so each file is hashed while it is
 *    streamed and a file that vanishes mid-run can be recorded in
 *    `manifest.skipped`;
 * 5. fsyncs the file, then VERIFIES it (a full stream decrypt plus the
 *    manifest/sha256 check, ./full-verify.ts) while it is still `.partial`;
 * 6. renames it into place and fsyncs the folder;
 * 7. writes the `BACKUP_CREATED` audit entry.
 * On any failure `.partial` is removed and the lock released. Invariant:
 * every `blackvault-full-*.bvb` in the folder has verified once.
 *
 * Memory: one uploaded file at a time (`readDecryptedFile` returns a whole
 * Buffer; uploads are capped at 10–20 MB), one 1 MiB sealer chunk, the stream
 * buffers, and `db.json` (read once, small next to the files).
 */

export { DEFAULT_FULL_BACKUP_DIR };
export const FULL_BACKUP_PREFIX = "blackvault-full-";
export const FULL_BACKUP_SUFFIX = ".bvb";
const PARTIAL_SUFFIX = ".partial";

/** The two folders under the uploads root that hold user files, and where each goes in the archive. */
const UPLOAD_FOLDERS = [
  { dir: "images", archive: "files/images" },
  { dir: "documents", archive: "files/documents" },
] as const;

/** Directory-fsync failures some platforms/filesystems raise instead of succeeding (same list as storage.ts). */
const DIR_FSYNC_TOLERATED_CODES = new Set(["EPERM", "EISDIR", "EINVAL"]);

export class FullBackupError extends Error {
  readonly code: "BACKUP_DIR_NOT_WRITABLE" | "VERIFY_MISMATCH";

  constructor(code: FullBackupError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FullBackupError";
    this.code = code;
  }
}

export interface FullBackupProgress {
  /**
   * - `writing`: files are being read, decrypted and sealed. `bytes*` count
   *   the files' sizes ON DISK (encrypted), which is what is known up front.
   *   A file that vanished still counts as done.
   * - `verifying`: the sealed archive is being read back. `files*`/`bytes*`
   *   count the archive's file entries and their plaintext sizes.
   */
  phase: "writing" | "verifying";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface FullBackupOptions {
  /** NFC-normalised by the sealer; at least 12 code points (SealError PASSPHRASE_TOO_SHORT otherwise). */
  passphrase: string;
  /** The backup folder. Must already exist and be writable. */
  dir?: string;
  /** Called (not awaited) as the run advances. An error it throws is ignored. */
  onProgress?: (progress: FullBackupProgress) => void | Promise<void>;
  /** Where the uploads root is read from (`IMAGE_UPLOAD_DIR`). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The backup's timestamp (file name, manifest, db.json meta). Defaults to now. */
  now?: Date;
  /**
   * Who the audit entry names. Omit it and the actor is resolved the usual
   * way — `system` outside a request (the CLI). The Settings button's job
   * runs after its request has returned, so it passes the admin explicitly.
   */
  actor?: { actorId: string | null; actorName: string };
}

export interface FullBackupResult {
  /** The archive's file name, e.g. `blackvault-full-20261002-180405.bvb`. */
  file: string;
  /** Its absolute path. */
  path: string;
  /** Number of uploaded files in the archive. */
  files: number;
  /** Total plaintext size of those files, in bytes. */
  bytes: number;
  /** Size of the `.bvb` file itself, in bytes. */
  archiveBytes: number;
  /**
   * Files that are NOT in the archive (also in `manifest.skipped`, as
   * `{ path, reason }`). `vanished`: deleted while the backup ran — expected
   * on a live install. `unreadable`: the file exists but could not be read or
   * decrypted — the caller must warn about every one of these.
   */
  skipped: FullBackupSkipped[];
}

export interface FullBackupSkipped extends ManifestSkippedEntry {
  kind: "vanished" | "unreadable";
}

interface UploadEntry {
  abs: string;
  archivePath: string;
  diskSize: number;
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/**
 * Why one file could not be put in the archive, or null when the failure is
 * not about that file and must fail the run.
 * - ENOENT: the file was deleted after it was listed (spec §2 step 4).
 * - It exists but cannot be decrypted (FileAtRestError: damaged, a foreign
 *   key, plaintext at rest) or cannot be read (an fs error such as EACCES or
 *   EIO): skipped as `unreadable` (ruling R9) — one bad upload must not block
 *   every backup, but the caller has to say so loudly.
 * Anything else (the encryption key cannot be loaded, a bug) is not a
 * property of this file: skipping would turn "nothing can be read" into a
 * successful, empty backup.
 */
function classifyReadFailure(e: unknown): { kind: FullBackupSkipped["kind"]; reason: string } | null {
  if (e instanceof FileAtRestError) {
    const why = e.code === "PLAINTEXT_AT_REST" ? e.code : (e.causeCode ?? e.code);
    return { kind: "unreadable", reason: `unreadable: could not be decrypted (${why})` };
  }
  const fsError = e as NodeJS.ErrnoException | null;
  if (fsError && typeof fsError.code === "string" && typeof fsError.syscall === "string") {
    if (fsError.code === "ENOENT") return { kind: "vanished", reason: "vanished during the backup (deleted while it ran)" };
    return { kind: "unreadable", reason: `unreadable: could not be read (${fsError.code})` };
  }
  return null;
}

/** `*.tmp` (an interrupted writeAtomic), `*.rot` (key rotation staging) and hidden entries are never backed up. */
function isExcludedName(name: string): boolean {
  return name.startsWith(".") || name.endsWith(".tmp") || name.endsWith(".rot");
}

/**
 * Every regular file under `<root>/images` and `<root>/documents`, in a
 * stable order. Hidden entries (which covers `.pre-encryption-*`,
 * `.restore-*` and `.pre-restore-*` folders), `*.tmp`, `*.rot` and symlinks —
 * to files or to folders — are left out; a symlink is never followed. A
 * folder that is missing (no uploads yet) or disappears mid-walk is empty.
 */
async function listUploads(root: string): Promise<UploadEntry[]> {
  const found: UploadEntry[] = [];
  async function visit(dir: string, archiveDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR") return;
      throw e;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (isExcludedName(e.name) || e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const archivePath = `${archiveDir}/${e.name}`;
      if (e.isDirectory()) await visit(abs, archivePath);
      else if (e.isFile()) {
        // A file gone between readdir and lstat stays listed: reading it
        // below is what records it as skipped.
        const diskSize = await fsp.lstat(abs).then((s) => s.size, () => 0);
        found.push({ abs, archivePath, diskSize });
      }
    }
  }
  for (const { dir, archive } of UPLOAD_FOLDERS) {
    const top = path.join(root, dir);
    // The top folder itself must be a real folder, not a link to one.
    const stat = await fsp.lstat(top).catch(() => null);
    if (stat?.isDirectory()) await visit(top, archive);
  }
  return found;
}

async function assertBackupDirWritable(dir: string): Promise<void> {
  const hint =
    "Create it and make it writable by the app (uid 1001 in the container); with Docker it is the folder mounted from BLACKVAULT_BACKUP_DIR (default ./data/backups).";
  let stat;
  try {
    stat = await fsp.stat(dir);
  } catch (e) {
    throw new FullBackupError("BACKUP_DIR_NOT_WRITABLE", `The backup folder ${dir} does not exist or cannot be read (${codeOf(e) ?? "error"}). ${hint}`, {
      cause: e,
    });
  }
  if (!stat.isDirectory()) {
    throw new FullBackupError("BACKUP_DIR_NOT_WRITABLE", `The backup folder ${dir} is not a folder. ${hint}`);
  }
  try {
    await fsp.access(dir, fsConstants.W_OK | fsConstants.X_OK);
  } catch (e) {
    throw new FullBackupError("BACKUP_DIR_NOT_WRITABLE", `The backup folder ${dir} is not writable (${codeOf(e) ?? "error"}). ${hint}`, { cause: e });
  }
}

/** Leftovers of a run that was killed: with the lock held, no `.partial` here belongs to a live backup. */
async function removeOrphanedPartials(dir: string): Promise<void> {
  for (const name of await fsp.readdir(dir)) {
    if (name.startsWith(FULL_BACKUP_PREFIX) && name.endsWith(FULL_BACKUP_SUFFIX + PARTIAL_SUFFIX)) {
      await fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Creates `blackvault-full-<YYYYmmdd-HHMMSS>.bvb.partial` empty, mode 0600
 * (chmod too: a default ACL on the folder can override the creation mode),
 * before any data is written. If that second's name is already taken — by a
 * finished backup or another partial — the next second's is used, so a
 * backup never overwrites an earlier one.
 */
async function createPartial(dir: string, now: Date): Promise<{ file: string; partialPath: string; handle: FileHandle }> {
  for (let bump = 0; bump < 120; bump++) {
    const file = `${FULL_BACKUP_PREFIX}${snapshotStamp(new Date(now.getTime() + bump * 1000))}${FULL_BACKUP_SUFFIX}`;
    const finalPath = path.join(dir, file);
    if (await fsp.lstat(finalPath).then(() => true, () => false)) continue;
    const partialPath = finalPath + PARTIAL_SUFFIX;
    let handle: FileHandle;
    try {
      handle = await fsp.open(partialPath, "wx", 0o600);
    } catch (e) {
      if (codeOf(e) === "EEXIST") continue;
      throw e;
    }
    try {
      await handle.chmod(0o600);
    } catch (e) {
      await handle.close().catch(() => undefined);
      await fsp.rm(partialPath, { force: true }).catch(() => undefined);
      throw e;
    }
    return { file, partialPath, handle };
  }
  throw new Error(`Could not find a free backup file name in ${dir}.`);
}

/**
 * A Writable over an open file handle. Each chunk is written in full —
 * `write(2)` may return short without an error (storage.ts's writeFull has
 * the story) — and the first failure is remembered in `failure`, so the
 * caller can report the real cause (ENOSPC) rather than the "stream
 * destroyed" error the tar writer sees downstream of it.
 */
function fileSink(handle: FileHandle): { sink: Writable; failure: () => Error | null } {
  let failure: Error | null = null;
  const sink = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      (async () => {
        let written = 0;
        while (written < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, written, chunk.length - written);
          if (bytesWritten <= 0) throw new Error("full backup: write() made no forward progress (0 bytes written)");
          written += bytesWritten;
        }
      })().then(
        () => callback(),
        (e) => {
          failure = e instanceof Error ? e : new Error(String(e));
          callback(failure);
        },
      );
    },
  });
  return { sink, failure: () => failure };
}

/**
 * `buf` as a run of 1 MiB views (no copy). Handing the tar writer a whole
 * 16 MiB file as ONE chunk makes the sealer encrypt all of it in a single
 * synchronous step and queue every ciphertext chunk at once; fed a slice at a
 * time, with the writer awaiting backpressure between slices, the sealed
 * bytes go to disk as they are produced.
 */
const SLICE_BYTES = 1024 * 1024;
function* slices(buf: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < buf.length; offset += SLICE_BYTES) yield buf.subarray(offset, offset + SLICE_BYTES);
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await fsp.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (e) {
    const code = codeOf(e);
    if (!code || !DIR_FSYNC_TOLERATED_CODES.has(code)) throw e;
  }
}

/**
 * Makes one full backup. Resolves once the archive is verified, renamed into
 * place and audited. Rejects with
 * - `FullBackupAlreadyRunningError` (./full-lock.ts) — another backup holds
 *   the lock (CLI exit 2, HTTP 409);
 * - `FullBackupError` — the folder is not writable (the message names it), or
 *   the verified archive does not match what was written;
 * - `SealError` PASSPHRASE_TOO_SHORT;
 * - the underlying error otherwise (ENOSPC, a database error, a verify
 *   failure).
 */
export async function runFullBackup(opts: FullBackupOptions): Promise<FullBackupResult> {
  const dir = path.resolve(opts.dir ?? DEFAULT_FULL_BACKUP_DIR);
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const report = (progress: FullBackupProgress): void => {
    if (!opts.onProgress) return;
    try {
      void Promise.resolve(opts.onProgress(progress)).catch(() => undefined);
    } catch {
      // Progress reporting must never fail a backup.
    }
  };

  await assertBackupDirWritable(dir);
  const lock = await acquireFullBackupLock(dir);
  let partialPath: string | null = null;
  let handle: FileHandle | null = null;
  try {
    // Before any work: a short passphrase is refused here (and scrypt runs once).
    const sealer = createBackupSealer(opts.passphrase);
    // If the run fails before the sealer is piped anywhere, nothing listens for its errors.
    sealer.on("error", () => undefined);

    await removeOrphanedPartials(dir);

    const records = await collectBackupRecords();
    const counts = backupCounts(records);
    const dbJson = Buffer.from(JSON.stringify(buildBackupPayload(records, { now, includeUploads: true })), "utf8");

    const uploads = await listUploads(uploadsRoot(env));
    const bytesTotal = uploads.reduce((sum, u) => sum + u.diskSize, 0);

    const created = await createPartial(dir, now);
    partialPath = created.partialPath;
    handle = created.handle;
    const file = created.file;

    const files: ManifestFileEntry[] = [];
    const skipped: FullBackupSkipped[] = [];
    const { sink, failure: sinkFailure } = fileSink(handle);
    const piped = pipeline(sealer, sink);
    piped.catch(() => undefined); // awaited below; never an unhandled rejection in between

    try {
      const tar = new TarWriter(sealer);
      await tar.addBuffer("db.json", dbJson);

      let filesDone = 0;
      let bytesDone = 0;
      report({ phase: "writing", filesDone, filesTotal: uploads.length, bytesDone, bytesTotal });
      for (const upload of uploads) {
        // The whole file is read and decrypted BEFORE its tar header is
        // written: once addBuffer starts, a failure poisons the writer, so
        // "this file vanished / cannot be read" has to be known by now, and
        // its size settled. A skipped file therefore never has a tar entry.
        let plaintext: Buffer | null = null;
        try {
          plaintext = await readDecryptedFile(upload.abs);
        } catch (e) {
          const skip = classifyReadFailure(e);
          if (!skip) throw e;
          skipped.push({ path: upload.archivePath, ...skip });
        }
        if (plaintext) {
          const sha256 = createHash("sha256").update(plaintext).digest("hex");
          await tar.addFile(upload.archivePath, plaintext.length, Readable.from(slices(plaintext), { objectMode: false }));
          files.push({ path: upload.archivePath, size: plaintext.length, sha256 });
        }
        filesDone += 1;
        bytesDone += upload.diskSize;
        report({ phase: "writing", filesDone, filesTotal: uploads.length, bytesDone, bytesTotal });
      }

      const manifest = buildManifest({
        appVersion: APP_VERSION,
        createdAt: now,
        keyIdAtBackup: getFieldKeys().id,
        counts,
        files,
        skipped: skipped.map(({ path: skippedPath, reason }) => ({ path: skippedPath, reason })),
      });
      await tar.addBuffer("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
      await tar.finish();
      sealer.end();
      await piped;
    } catch (e) {
      sealer.destroy();
      await piped.catch(() => undefined);
      throw sinkFailure() ?? e;
    }

    await handle.sync();
    await handle.close();
    handle = null;

    // Verified while still `.partial`: nothing unverified ever carries the final name.
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const verified = await verifyFullBackup(partialPath, opts.passphrase, {
      onProgress: (p) => report({ phase: "verifying", filesDone: p.filesDone, filesTotal: files.length, bytesDone: p.bytesDone, bytesTotal: bytes }),
    });
    if (verified.files !== files.length || verified.bytes !== bytes) {
      throw new FullBackupError(
        "VERIFY_MISMATCH",
        `The new backup did not verify: it holds ${verified.files} files (${verified.bytes} bytes) but ${files.length} (${bytes} bytes) were written.`,
      );
    }

    const finalPath = path.join(dir, file);
    await fsp.rename(partialPath, finalPath);
    partialPath = null;
    await fsyncDir(dir);

    await recordEventBestEffort(null, {
      action: "BACKUP_CREATED",
      entityLabel: file,
      changes: { full: true, file, files: files.length, bytes, verified: true, skipped: skipped.length },
      ...(opts.actor ? { actorOverride: opts.actor } : {}),
    });

    return { file, path: finalPath, files: files.length, bytes, archiveBytes: verified.archiveBytes, skipped };
  } catch (e) {
    if (handle) await handle.close().catch(() => undefined);
    if (partialPath) await fsp.rm(partialPath, { force: true }).catch(() => undefined);
    throw e;
  } finally {
    await lock.release();
  }
}
