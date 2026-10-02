import { promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { decryptFile, encryptFile, fileKeyId, isEncryptedFile, type FieldKeys } from "../encryption/core.mjs";
import { getFieldKeys } from "../encryption/keys";
import { SNAPSHOT_REUSE_MS, snapshotStamp } from "../encryption/pre-encryption-snapshot";
import { SYSTEM_ACTOR } from "../audit/context";
import { writeAuditEvent } from "../audit/record";
import { isSafeDocumentUrl } from "../upload-security";
import { legacyDocumentsRoot, uploadsRoot, writeAtomic } from "./storage";

/**
 * The startup file step of encrypted files at rest (spec 3b,
 * docs/superpowers/specs/2026-10-01-encrypted-files-design.md §2 "Startup"
 * and §3 "Resume"). Called from runEncryptionStartup
 * (src/lib/encryption/startup.ts) after 3a's database migration and
 * compaction, on the same raw client, before the app serves — so no request
 * can read a file while this rewrites it (Review Focus 3).
 *
 * Order:
 * 1. delete leftover `*.tmp` files (an interrupted writeAtomic);
 * 2. resolve `.rot` files (an interrupted key rotation, §3 step 4);
 * 3. refuse if any BVF1 file is under a key id other than the current one
 *    (§3 step 4 "Then …"). Checked here, BEFORE anything below changes a
 *    file, so a refusal leaves the uploads exactly as they were;
 * 4. move legacy documents onto the volume;
 * 5. snapshot every plaintext file (unless the update script already did);
 * 6. encrypt every plaintext file in place, atomically, one at a time;
 * 7. report documents whose file is missing;
 * 8. write one FILES_ENCRYPTED audit event when something changed.
 *
 * Every failure that could leave a file unreadable throws; the caller
 * refuses to start. Nothing already done is rolled back: each file is either
 * its original plaintext or a complete BVF1 file, so the next start resumes.
 * Nothing here ever deletes the only copy of an uploaded file.
 *
 * fsp.* is always called through the imported namespace object so tests can
 * `vi.spyOn(fsp, …)` (same rule as ./storage.ts). Imports stay relative (no
 * `@/`): scripts load this under plain ts-node.
 */

export type FileStartupResult = {
  moved: number;
  counts: { images: number; documents: number };
  missing: { id: string; name: string }[];
  snapshot: string | null;
  finishedRotations: number;
};

export type FileStartupOptions = { now?: Date; cwd?: string; env?: NodeJS.ProcessEnv };

type RawClient = Pick<PrismaClient, "document" | "auditEvent">;

/** A refusal to start, with a message that names the file and the fix. */
export class FileStartupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "FileStartupError";
  }
}

/** The app's own snapshot folders (and their `.partial` work-in-progress). Never scanned, never swept. */
export const UPLOADS_SNAPSHOT_PREFIX = ".pre-encryption-";
const FINAL_SNAPSHOT = /^\.pre-encryption-\d{8}-\d{6}(-\d+)?$/;
const PARTIAL_SNAPSHOT = /^\.pre-encryption-\d{8}-\d{6}(-\d+)?\.partial$/;

/** At most this many `{ id, name }` entries go into the audit event; `missingTotal` has the full count. */
export const MISSING_AUDIT_CAP = 200;

/** Header bytes needed to classify a file: BVF1 header (13) + IV (12) + tag (16). See fileKeyId in core.mjs. */
const CLASSIFY_BYTES = 41;

const DIR_FSYNC_TOLERATED_CODES = new Set(["EPERM", "EISDIR", "EINVAL"]);

type Entry = { abs: string; rel: string; name: string };

const codeOf = (e: unknown): string =>
  (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code) ||
  (e instanceof Error ? e.message : String(e));

async function lexists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fsp.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (!code || !DIR_FSYNC_TOLERATED_CODES.has(code)) throw e;
  }
}

/**
 * Every regular file under `dir` (sorted, relative paths with `/`), never
 * following a symlink and never entering a `.pre-encryption-*` folder.
 * Symlinks are collected separately so the caller can report them.
 */
async function walk(root: string): Promise<{ files: Entry[]; symlinks: string[] }> {
  const files: Entry[] = [];
  const symlinks: string[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (rel === "" && (e as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw new FileStartupError(`Could not read the folder ${dir} (${codeOf(e)}). Fix its permissions and start again.`, e);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) symlinks.push(abs);
      else if (e.isDirectory()) {
        if (!e.name.startsWith(UPLOADS_SNAPSHOT_PREFIX)) await visit(abs, childRel);
      } else if (e.isFile()) files.push({ abs, rel: childRel, name: e.name });
    }
  }
  await visit(root, "");
  return { files, symlinks };
}

/** Files the startup scan may encrypt: not hidden, not a `.tmp` or `.rot` work file (spec §2 step 3). */
const isCandidate = (e: Entry) => !e.name.startsWith(".") && !e.name.endsWith(".tmp") && !e.name.endsWith(".rot");

/** The first CLASSIFY_BYTES of `abs` (fewer when the file is shorter). Refuses to start, naming the file, if it cannot be read. */
async function readHead(abs: string): Promise<Buffer> {
  try {
    const handle = await fsp.open(abs, "r");
    try {
      const buf = Buffer.alloc(CLASSIFY_BYTES);
      let got = 0;
      while (got < CLASSIFY_BYTES) {
        const { bytesRead } = await handle.read(buf, got, CLASSIFY_BYTES - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } finally {
      await handle.close();
    }
  } catch (e) {
    throw new FileStartupError(
      `Could not read the uploaded file ${abs} (${codeOf(e)}), so its encryption state is unknown. ` +
        "Fix the file's permissions (or move it out of the uploads folder) and start again.",
      e,
    );
  }
}

type Classified = { plaintext: Entry[]; foreign: Array<{ entry: Entry; keyId: string }>; malformed: Entry[] };

async function classify(files: Entry[], keys: FieldKeys): Promise<Classified> {
  const out: Classified = { plaintext: [], foreign: [], malformed: [] };
  for (const f of files.filter(isCandidate)) {
    const head = await readHead(f.abs);
    if (!isEncryptedFile(head)) {
      out.plaintext.push(f);
      continue;
    }
    let id: string;
    try {
      id = fileKeyId(head);
    } catch {
      out.malformed.push(f);
      continue;
    }
    if (id !== keys.id) out.foreign.push({ entry: f, keyId: id });
  }
  return out;
}

/**
 * Where `abs` is on the HOST, mirroring hostPathOf in
 * ../encryption/pre-encryption-snapshot.ts (which maps /app/data). In the
 * container the uploads root is /app/uploads, which docker-compose.yml
 * mounts from ${DATA_DIR}/uploads; BLACKVAULT_HOST_UPLOADS_DIR, when set,
 * names that host folder. Outside a container the path is already a host path.
 */
export function uploadsHostPath(abs: string, env: NodeJS.ProcessEnv = process.env): string {
  const inContainerDir = "/app/uploads/";
  if (!abs.startsWith(inContainerDir)) return abs;
  const hostDir = (env.BLACKVAULT_HOST_UPLOADS_DIR ?? "").trim();
  if (hostDir) return path.posix.join(hostDir.replace(/\\/g, "/"), abs.slice(inContainerDir.length));
  return `${abs} (in the container; on the host it is in the uploads/ folder of your BlackVault data directory)`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ─── Step 2: interrupted rotations ──────────────────────────────

async function resolveRotations(files: Entry[], keys: FieldKeys, log: (l: string) => void, warn: (l: string) => void): Promise<number> {
  let finished = 0;
  for (const f of files.filter((e) => e.name.endsWith(".rot") && !e.name.startsWith("."))) {
    const original = f.abs.slice(0, -".rot".length);
    const basename = path.basename(original);
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(f.abs);
    } catch (e) {
      throw new FileStartupError(`Could not read the key-rotation file ${f.abs} (${codeOf(e)}). Fix its permissions and start again.`, e);
    }
    let current = false;
    try {
      current = fileKeyId(bytes) === keys.id;
    } catch {
      current = false;
    }
    const originalExists = await lexists(original);
    if (current) {
      // Only ever put a .rot in place once it is proven to decrypt, under the
      // name it is about to take (the AAD binds the original's basename).
      try {
        decryptFile(keys, basename, bytes);
      } catch (e) {
        throw new FileStartupError(
          `The key-rotation file ${f.abs} is under the current key but does not decrypt (${codeOf(e)}); ` +
            `it was left in place and ${original} was not touched. Restore the uploads folder from a backup, or move this file away, and start again.`,
          e,
        );
      }
      await fsp.rename(f.abs, original);
      await syncDir(path.dirname(original));
      finished++;
      if (originalExists) log(`[files] Finished an interrupted key rotation for ${original}.`);
      else log(`[files] Finished an interrupted key rotation: ${original} was missing, so its re-encrypted copy (the only copy) was put in place.`);
    } else if (!originalExists) {
      warn(
        `[files] WARNING: left ${f.abs} in place: it is not under the current key and its original ${original} is missing, ` +
          "so it may be the only copy of that file.",
      );
    } else {
      await fsp.rm(f.abs, { force: true });
      log(`[files] Removed ${f.abs}: staging from a key rotation that did not commit.`);
    }
  }
  return finished;
}

// ─── Step 4: legacy documents ───────────────────────────────────

async function moveAcrossDevices(src: string, dest: string): Promise<void> {
  const bytes = await fsp.readFile(src);
  await writeAtomic(dest, bytes); // copy + fsync file + rename + fsync dir
  const copied = await fsp.readFile(dest);
  if (!copied.equals(bytes)) throw new Error(`the copy at ${dest} does not match the original`);
  await fsp.unlink(src);
}

async function moveLegacyDocuments(legacyDir: string, docsDir: string, log: (l: string) => void, warn: (l: string) => void): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(legacyDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw new FileStartupError(`Could not read the old documents folder ${legacyDir} (${codeOf(e)}). Fix its permissions and start again.`, e);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let moved = 0;
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const src = path.join(legacyDir, e.name);
    const dest = path.join(docsDir, e.name);
    await fsp.mkdir(docsDir, { recursive: true });
    if (await lexists(dest)) {
      warn(`[files] Did not move ${src}: ${dest} already exists. The existing file was kept and the old copy left where it is.`);
      continue;
    }
    try {
      try {
        await fsp.rename(src, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
        await moveAcrossDevices(src, dest);
      }
      await syncDir(docsDir);
      await syncDir(legacyDir);
    } catch (err) {
      throw new FileStartupError(
        `Could not move the document ${src} to ${dest} (${codeOf(err)}). The original was left in place. ` +
          "Free disk space or fix the folders' permissions and start again.",
        err,
      );
    }
    moved++;
    log(`[files] Moved document ${src} to ${dest}.`);
  }
  return moved;
}

// ─── Step 5: snapshot ───────────────────────────────────────────

async function mkdirPrivate(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
  }
  // A default ACL on the parent can override the creation mode (3a lesson).
  await fsp.chmod(dir, 0o700);
}

/** Created empty, chmodded 0600, THEN written (3a lesson), then fsynced. */
async function copyPrivate(src: string, dest: string): Promise<void> {
  const bytes = await fsp.readFile(src);
  const handle = await fsp.open(dest, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The newest complete snapshot (< SNAPSHOT_REUSE_MS old) that already holds every file in `plaintext`, byte for byte. */
async function reusableSnapshot(root: string, plaintext: Entry[], now: Date): Promise<string | null> {
  const names = (await fsp.readdir(root)).filter((n) => FINAL_SNAPSHOT.test(n));
  const candidates: Array<{ dir: string; mtime: number }> = [];
  for (const n of names) {
    const st = await fsp.lstat(path.join(root, n));
    if (st.isDirectory() && now.getTime() - st.mtimeMs < SNAPSHOT_REUSE_MS) candidates.push({ dir: path.join(root, n), mtime: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    let all = true;
    for (const f of plaintext) {
      try {
        const [a, b] = await Promise.all([fsp.readFile(path.join(c.dir, ...f.rel.split("/"))), fsp.readFile(f.abs)]);
        if (!a.equals(b)) all = false;
      } catch {
        all = false;
      }
      if (!all) break;
    }
    if (all) return c.dir;
  }
  return null;
}

async function takeUploadsSnapshot(root: string, plaintext: Entry[], now: Date): Promise<{ dir: string; reused: boolean }> {
  let needed = 0;
  for (const f of plaintext) needed += (await fsp.stat(f.abs)).size;
  let partial: string | null = null;
  try {
    const reuse = await reusableSnapshot(root, plaintext, now);
    if (reuse) return { dir: reuse, reused: true };
    for (const n of await fsp.readdir(root)) {
      if (PARTIAL_SNAPSHOT.test(n)) await fsp.rm(path.join(root, n), { recursive: true, force: true });
    }
    let final = path.join(root, `${UPLOADS_SNAPSHOT_PREFIX}${snapshotStamp(now)}`);
    if (await lexists(final)) final = path.join(root, `${UPLOADS_SNAPSHOT_PREFIX}${snapshotStamp(now)}-${process.pid}`);
    // Written under a .partial name and renamed only once complete, so a copy
    // killed part-way never looks like a finished snapshot.
    partial = `${final}.partial`;
    await mkdirPrivate(partial);
    for (const f of plaintext) {
      const segments = f.rel.split("/");
      let dir = partial;
      for (const seg of segments.slice(0, -1)) {
        dir = path.join(dir, seg);
        await mkdirPrivate(dir);
      }
      await copyPrivate(f.abs, path.join(dir, segments[segments.length - 1]));
    }
    await syncDir(partial);
    await fsp.rename(partial, final);
    await syncDir(root);
    return { dir: final, reused: false };
  } catch (e) {
    if (partial) await fsp.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw new FileStartupError(
      `Could not take the pre-encryption snapshot of the uploads folder, so nothing was encrypted (${codeOf(e)}). ` +
        `It needs about ${formatBytes(needed)} of free space in ${root}. Free disk space or fix the folder's permissions and start again.`,
      e,
    );
  }
}

// ─── Step 6: encrypt ────────────────────────────────────────────

async function encryptInPlace(f: Entry, keys: FieldKeys): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(f.abs);
  } catch (e) {
    throw new FileStartupError(`Could not read ${f.abs} to encrypt it (${codeOf(e)}). Fix its permissions and start again; files already encrypted stay encrypted.`, e);
  }
  if (isEncryptedFile(bytes)) return false;
  try {
    const stored = encryptFile(keys, f.name, bytes);
    // Never install bytes that do not decrypt back to the original.
    if (!decryptFile(keys, f.name, stored).equals(bytes)) throw new Error("round-trip check failed");
    await writeAtomic(f.abs, stored);
  } catch (e) {
    throw new FileStartupError(
      `Could not encrypt ${f.abs} (${codeOf(e)}); it was left unchanged. Free disk space or fix its permissions and start again; ` +
        "files already encrypted stay encrypted and the rest are finished on the next start.",
      e,
    );
  }
  return true;
}

// ─── Step 7: missing documents ──────────────────────────────────

async function findMissingDocuments(raw: RawClient, docsDir: string, warn: (l: string) => void): Promise<{ id: string; name: string }[]> {
  const rows = await raw.document.findMany({
    select: { id: true, name: true, fileUrl: true, firearmId: true, accessoryId: true, gearId: true },
    orderBy: { id: "asc" },
  });
  const missing: { id: string; name: string }[] = [];
  for (const d of rows) {
    // Only rows that point at an uploaded file; a document can also be a link (POST /api/documents).
    if (!isSafeDocumentUrl(d.fileUrl)) continue;
    const fileName = d.fileUrl.slice(d.fileUrl.lastIndexOf("/") + 1);
    const abs = path.join(docsDir, fileName);
    if (await lexists(abs)) continue;
    missing.push({ id: d.id, name: d.name });
    const item = d.firearmId ? `firearm ${d.firearmId}` : d.accessoryId ? `accessory ${d.accessoryId}` : d.gearId ? `gear ${d.gearId}` : "none";
    warn(`[files] Missing document file: id=${d.id} name=${JSON.stringify(d.name)} item=${item} file=${abs}`);
  }
  return missing;
}

// ─── The step ───────────────────────────────────────────────────

export async function runFileStartup(raw: RawClient, opts: FileStartupOptions = {}): Promise<FileStartupResult> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const log = (line: string) => console.log(line);
  const warn = (line: string) => console.error(line);
  const keys = getFieldKeys();

  const root = env.IMAGE_UPLOAD_DIR ? uploadsRoot(env) : path.join(cwd, "uploads");
  const docsDir = path.join(root, "documents");
  const isDocument = (e: Entry) => e.rel.startsWith("documents/");

  // 1. Leftover temp files from an interrupted atomic write.
  for (const f of (await walk(root)).files.filter((e) => e.name.endsWith(".tmp"))) {
    await fsp.rm(f.abs, { force: true });
    log(`[files] Removed a leftover temporary file: ${f.abs}`);
  }

  // 2. Interrupted key rotation.
  const finishedRotations = await resolveRotations((await walk(root)).files, keys, log, warn);

  // 3. Refuse on any file under another key, before anything else changes.
  const before = await classify((await walk(root)).files, keys);
  if (before.malformed.length) {
    throw new FileStartupError(
      `The uploaded file ${before.malformed[0].abs} starts like an encrypted file but its header is damaged` +
        `${before.malformed.length > 1 ? ` (and ${before.malformed.length - 1} more)` : ""}. ` +
        "Restore it from a backup or move it out of the uploads folder, then start again.",
    );
  }
  if (before.foreign.length) {
    const first = before.foreign[0];
    throw new FileStartupError(
      `The uploaded file ${first.entry.abs} is encrypted with key ${first.keyId}, not the current key ${keys.id}` +
        `${before.foreign.length > 1 ? ` (and ${before.foreign.length - 1} more files)` : ""}. ` +
        "A key rotation may not have finished: start with the key that encrypted it, or run the rotation again.",
    );
  }

  // 4. Legacy documents onto the volume.
  const moved = await moveLegacyDocuments(legacyDocumentsRoot(cwd), docsDir, log, warn);

  // Rescan: the moved documents are new plaintext.
  const scan = await walk(root);
  for (const link of scan.symlinks) {
    warn(`[files] WARNING: skipped the symbolic link ${link}: uploaded files are never links, so it was left as it is and not encrypted.`);
  }
  const { plaintext } = await classify(scan.files, keys);

  // 5. Snapshot.
  let snapshot: string | null = null;
  if (plaintext.length) {
    const marker = (env.BLACKVAULT_UPLOADS_SNAPSHOT ?? "").trim();
    if (marker) {
      snapshot = marker;
      log(`[files] The update script already saved a snapshot of the uploads folder: ${marker}`);
    } else {
      const taken = await takeUploadsSnapshot(root, plaintext, now);
      snapshot = uploadsHostPath(taken.dir, env);
      if (taken.reused) {
        log(`[files] Keeping the snapshot of the uploads folder taken earlier: ${snapshot}`);
      } else {
        log(`[files] Snapshot of the uploads folder taken before encrypting: ${snapshot}`);
        log(
          "[files] It is a PLAINTEXT copy of your photos and documents. Delete it once BlackVault is confirmed working. " +
            "On Linux it is owned by the container user (uid 1001): delete it with sudo rm -r.",
        );
      }
    }
  }

  // 6. Encrypt.
  const counts = { images: 0, documents: 0 };
  for (const f of plaintext) {
    if (await encryptInPlace(f, keys)) {
      if (isDocument(f)) counts.documents++;
      else counts.images++;
    }
  }
  if (counts.images || counts.documents) {
    log(`[files] Encrypted existing uploads: ${counts.images} photos, ${counts.documents} documents.`);
  }

  // 7. Missing documents (logged; never a refusal).
  const missing = await findMissingDocuments(raw, docsDir, warn);

  // 8. Audit. Missing documents alone are audited only the first time (no
  // earlier FILES_ENCRYPTED event), so a restart with the same missing files
  // does not add an event every time.
  let write = counts.images + counts.documents + moved > 0;
  if (!write && missing.length > 0) {
    write = (await raw.auditEvent.count({ where: { action: "FILES_ENCRYPTED" } })) === 0;
  }
  if (write) {
    await writeAuditEvent(raw, {
      action: "FILES_ENCRYPTED",
      actor: SYSTEM_ACTOR,
      changes: { counts, moved, missing: missing.slice(0, MISSING_AUDIT_CAP), missingTotal: missing.length, keyId: keys.id, snapshot },
    });
  }

  return { moved, counts, missing, snapshot, finishedRotations };
}
