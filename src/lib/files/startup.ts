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
import { dbStepMarkerName, markerStamp, RESTORE_STAMP } from "../backup/restore-marker";
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

/**
 * writeAtomic's own temp names (`<name>.<8 random hex>.tmp`, ./storage.ts).
 * Fix round 1, M1: the sweep deletes ONLY these, never some other file that
 * merely ends in `.tmp`. Rotation's `.rot` staging is written through
 * writeAtomic too, so its temps are `<name>.rot.<8 hex>.tmp` and match.
 */
export const WRITE_ATOMIC_TMP = /\.[0-9a-f]{8}\.tmp$/;

/** Fix round 1, M7: a progress line every this many files during the snapshot and the encryption. */
export const PROGRESS_EVERY = 250;

type Entry = { abs: string; rel: string; name: string };

const codeOf = (e: unknown): string =>
  (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code) ||
  (e instanceof Error ? e.message : String(e));

/**
 * Fix round 1, M6: runs one filesystem step and turns any raw error into a
 * FileStartupError that names the path, the error code and a fix.
 */
async function fsStep<T>(what: string, target: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FileStartupError) throw e;
    throw new FileStartupError(
      `Could not ${what} ${target} (${codeOf(e)}). Fix the uploads folder's permissions or free disk space, then start again.`,
      e,
    );
  }
}

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
 * following a symlink and never entering a hidden folder — which includes
 * the `.pre-encryption-*` snapshots (fix round 1, M5: the spec excludes
 * hidden files, and a file inside a hidden folder is hidden too).
 * Symlinked files are collected so the caller can report them. A symlinked
 * DIRECTORY the walk would have entered refuses to start (fix round 1, M4):
 * whatever it points at would be scanned, moved into or left plaintext
 * outside the uploads root.
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
      if (e.name.startsWith(".") && !e.isFile()) continue; // hidden folders (and links) are never entered
      if (e.isSymbolicLink()) {
        if (await isDirectoryLink(abs)) throw symlinkedFolderError(abs);
        symlinks.push(abs);
      } else if (e.isDirectory()) await visit(abs, childRel);
      else if (e.isFile()) files.push({ abs, rel: childRel, name: e.name });
    }
  }
  await visit(root, "");
  return { files, symlinks };
}

async function isDirectoryLink(abs: string): Promise<boolean> {
  try {
    return (await fsp.stat(abs)).isDirectory();
  } catch {
    return false; // dangling: reported as a skipped link, never followed
  }
}

function symlinkedFolderError(abs: string): FileStartupError {
  return new FileStartupError(
    `${abs} is a symbolic link to a folder. BlackVault does not follow links inside the uploads folder, so the files ` +
      "behind it would stay unencrypted. Replace the link with a real folder (move the files into it) and start again.",
  );
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

type Classified = { plaintext: Entry[]; current: Entry[]; foreign: Array<{ entry: Entry; keyId: string }>; malformed: Entry[] };

async function classify(files: Entry[], keys: FieldKeys): Promise<Classified> {
  const out: Classified = { plaintext: [], current: [], foreign: [], malformed: [] };
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
    else out.current.push(f);
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
      await fsStep("finish the key rotation by renaming", f.abs, async () => {
        await fsp.rename(f.abs, original);
        await syncDir(path.dirname(original));
      });
      finished++;
      if (originalExists) log(`[files] Finished an interrupted key rotation for ${original}.`);
      else log(`[files] Finished an interrupted key rotation: ${original} was missing, so its re-encrypted copy (the only copy) was put in place.`);
    } else if (!originalExists) {
      warn(
        `[files] WARNING: left ${f.abs} in place: it is not under the current key and its original ${original} is missing, ` +
          "so it may be the only copy of that file.",
      );
    } else {
      await fsStep("remove the uncommitted key-rotation file", f.abs, () => fsp.rm(f.abs, { force: true }));
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
  if (!copied.equals(bytes)) {
    // Fix round 1, M3: never leave a suspect copy behind — the next start
    // would take it for a collision, keep it and encrypt it. The source is
    // still the good copy.
    await fsp.rm(dest, { force: true });
    throw new Error(`the copy at ${dest} does not match the original`);
  }
  await fsp.unlink(src);
}

type LegacyMove = { src: string; dest: string; name: string };

/**
 * The legacy documents this start will move. Skipped (and logged): anything
 * not a regular file, hidden files, names a later step would never touch —
 * `.tmp` / `.rot` (fix round 1, M1: such a file was moved, never encrypted,
 * then deleted by the next start's sweep) — and names that already exist in
 * the new folder (Review Focus 1: the existing file is kept).
 */
async function planLegacyMoves(legacyDir: string, docsDir: string, warn: (l: string) => void): Promise<LegacyMove[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(legacyDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new FileStartupError(`Could not read the old documents folder ${legacyDir} (${codeOf(e)}). Fix its permissions and start again.`, e);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: LegacyMove[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const src = path.join(legacyDir, e.name);
    const dest = path.join(docsDir, e.name);
    if (e.name.endsWith(".tmp") || e.name.endsWith(".rot")) {
      warn(`[files] Did not move ${src}: BlackVault never wrote a document with this name, so it was left where it is.`);
      continue;
    }
    if (await fsStep("check", dest, () => lexists(dest))) {
      warn(`[files] Did not move ${src}: ${dest} already exists. The existing file was kept and the old copy left where it is.`);
      continue;
    }
    out.push({ src, dest, name: e.name });
  }
  return out;
}

async function moveLegacyDocuments(moves: LegacyMove[], legacyDir: string, docsDir: string, log: (l: string) => void): Promise<number> {
  let moved = 0;
  for (const { src, dest } of moves) {
    try {
      await fsp.mkdir(docsDir, { recursive: true });
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
  let partial: string | null = null;
  try {
    for (const f of plaintext) needed += (await fsp.stat(f.abs)).size;
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
    let done = 0;
    for (const f of plaintext) {
      const segments = f.rel.split("/");
      let dir = partial;
      for (const seg of segments.slice(0, -1)) {
        dir = path.join(dir, seg);
        await mkdirPrivate(dir);
      }
      await copyPrivate(f.abs, path.join(dir, segments[segments.length - 1]));
      if (++done % PROGRESS_EVERY === 0) console.log(`[files] snapshot ${done}/${plaintext.length}`);
    }
    await syncDir(partial);
    await fsp.rename(partial, final);
    await syncDir(root);
    return { dir: final, reused: false };
  } catch (e) {
    if (partial) await fsp.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw new FileStartupError(
      `Could not take the pre-encryption snapshot of the uploads folder, so nothing was encrypted (${codeOf(e)}). ` +
        `It needs about ${needed > 0 ? formatBytes(needed) : "the size of the uploads folder"} of free space in ${root}. Free disk space or fix the folder's permissions and start again.`,
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

// ─── An unfinished restore ──────────────────────────────────────

/** The uploads root the startup steps work on: IMAGE_UPLOAD_DIR, else `<cwd>/uploads`. */
const startupUploadsRoot = (env: NodeJS.ProcessEnv, cwd: string): string =>
  env.IMAGE_UPLOAD_DIR ? uploadsRoot(env) : path.join(cwd, "uploads");

/**
 * Refuses to start while a full restore's database-step marker is directly
 * under the uploads root. The restore program creates the marker just before
 * it replaces the database and removes it only when the whole restore has
 * succeeded; the wrapper (restore.sh / restore.bat) removes it once its
 * rollback has worked. One that is still there means the database and the
 * uploads may be half restored — the backup's records with the previous
 * files, or the other way round — and nothing may serve, migrate or encrypt
 * that.
 *
 * Read-only: one readdir of the uploads root. WHAT COUNTS AS A MARKER is
 * the name alone (markerStamp in ../backup/restore-marker.ts): any entry
 * directly under the root called `.restore-<anything>.db-started`, whatever
 * its type — a folder (what the restore program creates), a file, a link,
 * a dangling link. scripts/snapshot-restore.sh (`state`, `markers`) and the
 * wrappers use the same rule, so nothing the app refuses on is invisible to
 * the commands that clear it. A missing uploads root has no marker.
 *
 * Only the app's start calls this (runEncryptionStartup in
 * ../encryption/startup.ts). The restore, rollback, backup and key-rotation
 * commands never do: they are what clears the marker.
 */
export async function assertNoUnfinishedRestore(opts: Pick<FileStartupOptions, "cwd" | "env"> = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const root = startupUploadsRoot(env, opts.cwd ?? process.cwd());
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw new FileStartupError(`Could not read the folder ${root} (${codeOf(e)}). Fix its permissions and start again.`, e);
  }
  // Code-unit order, which for the restore program's stamps is oldest first.
  const stamps = names
    .map(markerStamp)
    .filter((s): s is string => s !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (stamps.length === 0) return;
  const one = stamps.length === 1;
  const markers = stamps.map((s) => restoreMarkerLocation(path.join(root, dbStepMarkerName(s)), env)).join(", ");
  // A recovery file is named after a stamp the restore program accepts; a marker with any other name has none.
  const recovery = stamps.filter((s) => RESTORE_STAMP.test(s)).map((s) => `backups/restore-${s}-RECOVERY.txt`);
  const whatToDo = recovery.length
    ? `If ${recovery.join(" or ")} exists (in the folder that holds docker-compose.yml), follow it: it ends by removing ` +
      "the marker. If no such file is there, the marker alone cannot say whether the install is whole: "
    : "No recovery file belongs to a marker with that name, so the marker alone cannot say whether the install is whole: ";
  throw new FileStartupError(
    `${one ? "A restore did not finish cleanly: its marker" : `${stamps.length} restores did not finish cleanly: their markers`} ${markers} ` +
      `${one ? "is" : "are"} still in the uploads folder. The database and the uploaded files may be half restored, so ` +
      `BlackVault will not start. ${whatToDo}delete the marker folder (on Linux it belongs to uid 1001: use sudo) only if ` +
      "the restore script had reported the restore as complete or as put back, and then start BlackVault again; otherwise " +
      "do not start on this install: restore a full backup with restore.sh or restore.bat, which says how to remove the " +
      'marker first. See the README, "Restoring a full backup".',
  );
}

/**
 * Where a marker is, for the refusal's message: the path as this process sees
 * it and, in a container, where that is on the host (uploadsHostPath).
 */
export function restoreMarkerLocation(abs: string, env: NodeJS.ProcessEnv = process.env): string {
  const host = uploadsHostPath(abs, env);
  return host === abs || host.startsWith(abs) ? host : `${abs} (on the host: ${host})`;
}

// ─── The step ───────────────────────────────────────────────────

export async function runFileStartup(raw: RawClient, opts: FileStartupOptions = {}): Promise<FileStartupResult> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const log = (line: string) => console.log(line);
  const warn = (line: string) => console.error(line);
  const keys = getFieldKeys();

  const root = startupUploadsRoot(env, cwd);
  const docsDir = path.join(root, "documents");
  const legacyDir = legacyDocumentsRoot(cwd);
  const isDocument = (e: Entry) => e.rel.startsWith("documents/");

  // Fix round 1, M4: legacy documents are moved INTO documents/, which the
  // walk below never sees when it is a link. Refuse before anything changes.
  if (await fsStep("check", docsDir, () => fsp.lstat(docsDir).then((st) => st.isSymbolicLink(), () => false))) {
    throw symlinkedFolderError(docsDir);
  }

  // 1. Leftover temp files from an interrupted atomic write — writeAtomic's own names only (M1).
  for (const f of (await walk(root)).files.filter((e) => WRITE_ATOMIC_TMP.test(e.name))) {
    await fsStep("remove the leftover temporary file", f.abs, () => fsp.rm(f.abs, { force: true }));
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
        "These files were encrypted by another BlackVault install or before a key rotation (for example, uploads " +
        "copied from another machine or restored from backups/uploads-*), and BlackVault cannot open them with " +
        "this key. Move them out of the uploads folder and start again; keep them, because they open only with the " +
        "key that encrypted them. On a new install that has no data yet, put that key in place instead and start " +
        'over (see the README, "Files encrypted with a different key").',
    );
  }

  // 4. Legacy documents onto the volume. Fix round 1, M8: the update script's
  // snapshot (the marker) copies only the host uploads folder, never the old
  // in-container documents folder — so with the marker set, the documents
  // about to move are snapshotted here first.
  const moves = await planLegacyMoves(legacyDir, docsDir, warn);
  const marker = (env.BLACKVAULT_UPLOADS_SNAPSHOT ?? "").trim();
  let legacySnapshot: string | null = null;
  if (marker && moves.length) {
    const entries = moves.map((m) => ({ abs: m.src, rel: `documents/${m.name}`, name: m.name }));
    legacySnapshot = await reportSnapshot(await takeUploadsSnapshot(root, entries, now), env, log);
  }
  const moved = await moveLegacyDocuments(moves, legacyDir, docsDir, log);

  // Rescan: the moved documents are new plaintext.
  const scan = await walk(root);
  for (const link of scan.symlinks) {
    warn(`[files] WARNING: skipped the symbolic link ${link}: uploaded files are never links, so it was left as it is and not encrypted.`);
  }
  const { plaintext, current } = await classify(scan.files, keys);

  // 5. Snapshot.
  let snapshot: string | null = null;
  if (marker && (plaintext.length || legacySnapshot)) {
    log(`[files] The update script already saved a snapshot of the uploads folder: ${marker}`);
    snapshot = legacySnapshot ? `${marker}; documents moved from the old folder: ${legacySnapshot}` : marker;
  } else if (plaintext.length) {
    snapshot = await reportSnapshot(await takeUploadsSnapshot(root, plaintext, now), env, log);
  }

  // 6. Encrypt.
  const counts = { images: 0, documents: 0 };
  let done = 0;
  for (const f of plaintext) {
    if (await encryptInPlace(f, keys)) {
      if (isDocument(f)) counts.documents++;
      else counts.images++;
    }
    if (++done % PROGRESS_EVERY === 0) log(`[files] encrypted ${done}/${plaintext.length}`);
  }
  if (counts.images || counts.documents) {
    log(`[files] Encrypted existing uploads: ${counts.images} photos, ${counts.documents} documents.`);
  }

  // 7. Missing documents (logged; never a refusal).
  const missing = await findMissingDocuments(raw, docsDir, warn);

  // 8. Audit. While no FILES_ENCRYPTED event exists yet (fix round 1, M2), the
  // first one carries the TOTALS — every BVF1 file per folder — so an event
  // lost to a failed audit write, or undercounted after a crash part-way, is
  // recovered by the next start. After that, only a start that changed
  // something writes one, with that start's counts.
  const changed = counts.images + counts.documents + moved > 0;
  const firstEvent = (await raw.auditEvent.count({ where: { action: "FILES_ENCRYPTED" } })) === 0;
  let eventCounts = counts;
  if (firstEvent) {
    eventCounts = { images: counts.images, documents: counts.documents };
    for (const f of current) {
      if (isDocument(f)) eventCounts.documents++;
      else eventCounts.images++;
    }
  }
  const anyEncrypted = eventCounts.images + eventCounts.documents > 0;
  if (changed || (firstEvent && (anyEncrypted || missing.length > 0))) {
    await writeAuditEvent(raw, {
      action: "FILES_ENCRYPTED",
      actor: SYSTEM_ACTOR,
      changes: {
        counts: eventCounts,
        moved,
        missing: missing.slice(0, MISSING_AUDIT_CAP),
        missingTotal: missing.length,
        keyId: keys.id,
        snapshot,
      },
    });
  }

  return { moved, counts, missing, snapshot, finishedRotations };
}

/** Logs a snapshot taken or reused; returns its host path. */
async function reportSnapshot(taken: { dir: string; reused: boolean }, env: NodeJS.ProcessEnv, log: (l: string) => void): Promise<string> {
  const where = uploadsHostPath(taken.dir, env);
  if (taken.reused) {
    log(`[files] Keeping the snapshot of the uploads folder taken earlier: ${where}`);
  } else {
    log(`[files] Snapshot of the uploads folder taken before encrypting: ${where}`);
    log(
      "[files] It is a PLAINTEXT copy of your photos and documents. Delete it once BlackVault is confirmed working. " +
        "On Linux it is owned by the container user (uid 1001): delete it with sudo rm -r.",
    );
  }
  return where;
}
