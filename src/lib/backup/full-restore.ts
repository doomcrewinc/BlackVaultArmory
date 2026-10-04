import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { recordEventBestEffort } from "@/lib/audit/events";
import { createBackupOpener } from "@/lib/encryption/core.mjs";
import { getFieldKeys } from "@/lib/encryption/keys";
import { snapshotStamp } from "@/lib/encryption/pre-encryption-snapshot";
import { uploadsRoot, writeEncryptedFile } from "@/lib/files/storage";
import { EntryNameSet, printableName } from "./entry-names";
import { acquireFullBackupLock } from "./full-lock";
import { checkDbAgainstCounts, checkEntriesAgainstManifest } from "./full-verify";
import { MAX_MANIFEST_BYTES, parseManifest, type Manifest } from "./manifest";
import { prepareBackupRestore } from "./restore-core";
import { DB_STEP_MARKER_SUFFIX, dbStepMarkerName, RESTORE_STAGING_PREFIX, RESTORE_STAMP } from "./restore-marker";
import { readTar } from "./tar";

/**
 * The full-restore engine (docs/superpowers/specs/2026-10-02-full-backups-design.md
 * §3 step 4): rebuilds a whole install —
 * database records, photos, documents — from one `.bvb` archive, onto an
 * install whose encryption key may differ from the one the backup was made
 * under. Run by restore.sh / restore.bat in a one-off container with the app
 * STOPPED, through `scripts/entry/full-restore.ts`.
 *
 * It replaces everything, so the order is strict and nothing is committed
 * until the whole archive has been read and checked:
 *
 * 1. STAGE. The archive is stream-decrypted. Every `files/...` entry is
 *    hashed and written, encrypted under the CURRENT key (BVF1,
 *    `writeEncryptedFile`), into `<uploads>/.restore-<ts>/{images,documents}/`.
 *    The archive's entries arrive as db.json, files, then manifest.json LAST,
 *    so the manifest is only known once everything is staged.
 * 2. CHECK. Only after the stream ended cleanly: the staged set must equal
 *    `manifest.files` exactly (none missing, none extra), with matching sizes
 *    and sha256s, db.json must hold the manifest's counts, and it must be
 *    a payload the shared restore logic accepts (`prepareBackupRestore`,
 *    ./restore-core.ts: every check that needs no write). Up to here
 *    nothing but the staging folder exists; a failure removes it.
 * 3. DATABASE. Every backup model's rows are replaced in one transaction by
 *    that same logic (shared with the browser restore), with a much longer
 *    time limit (FULL_RESTORE_TRANSACTION_TIMEOUT_MS). If it fails, nothing
 *    was written.
 * 4. FOLDERS. The live `images/` and `documents/` are renamed into
 *    `<uploads>/.pre-restore-<ts>/` — with every file they hold, including
 *    files the backup does not have (nothing is deleted) —
 *    and the staged folders are renamed into their place.
 * 5. The `RESTORE {full:true, file, files}` audit entry (the audit table is
 *    not part of a backup, so it survives the replace).
 *
 * ON FAILURE this module undoes what it can itself: the staging folder is
 * removed and every rename already done in step 4 is reversed, so the
 * uploads are as they were. It cannot undo a COMMITTED step 3:
 * `FullRestoreError.databaseReplaced` says whether that happened. The
 * wrapper restores the database (and re-checks the uploads) from the
 * snapshot it took before starting this. The flag only words the message:
 * what the wrapper goes by is the marker described below.
 *
 * Just before step 3 it leaves a durable marker, `.restore-<ts>.db-started/`
 * (see DB_STEP_MARKER_SUFFIX): the wrapper puts the DATABASE back
 * only when that marker exists. The whole run holds the full-backup lock.
 *
 * `.pre-restore-<ts>/` is never deleted here. The startup file scan, the
 * uploads snapshot and the full-backup walk all skip it and `.restore-*`.
 *
 * Memory: one file at a time (BVF1 is whole-file AES-GCM), plus db.json.
 */

export const PRE_RESTORE_PREFIX = ".pre-restore-";
/**
 * `<uploads>/.restore-<ts>.db-started/` is created — and flushed
 * to disk, with the uploads folder — just BEFORE the database step. While it
 * exists, the database may hold the backup's records: the wrapper puts the
 * database back from its snapshot only when it finds this marker, and never
 * touches a database the restore did not reach. It is written before the
 * commit on purpose: a commit whose acknowledgement was lost must still be
 * rolled back. This module removes it only when the whole restore succeeded;
 * after a failure it stays, for the wrapper (which removes it once its
 * rollback has worked). While one exists the app refuses to start
 * (assertNoUnfinishedRestore in ../files/startup.ts). A hidden folder named `.restore-*`: the startup scan,
 * the uploads snapshot and the backup walk all skip it.
 */
export { DB_STEP_MARKER_SUFFIX, dbStepMarkerName, RESTORE_STAGING_PREFIX } from "./restore-marker";

/** Same two folders, same archive roots, as the backup engine's walk (./full-backup.ts). */
const UPLOAD_FOLDERS = [
  { dir: "images" },
  { dir: "documents" },
] as const;

/**
 * The limit for the one write transaction: 30 minutes. The browser restore
 * allows 30 s because a person is waiting on a request; here BlackVault is
 * stopped, a snapshot exists and nobody else uses the database, so the only
 * job of the limit is to end a transaction that is truly stuck. A large
 * install on slow storage (a NAS, an SD card) needs minutes, not seconds,
 * and with 30 s it failed every restore — cleanly, but every time.
 */
export const FULL_RESTORE_TRANSACTION_TIMEOUT_MS = 30 * 60 * 1000;

const DB_ENTRY = "db.json";
const MANIFEST_ENTRY = "manifest.json";
/** One entry is held whole in memory, then encrypted (a second buffer). */
const MAX_ENTRY_BYTES = Math.min(bufferConstants.MAX_LENGTH - 64, 2 ** 31 - 1);
const DIR_FSYNC_TOLERATED_CODES = new Set(["EPERM", "EISDIR", "EINVAL"]);

export class FullRestoreError extends Error {
  /**
   * True when the database transaction had COMMITTED before the failure:
   * the records are the backup's, and only the snapshot can bring the old
   * ones back. False: the database was never changed.
   */
  readonly databaseReplaced: boolean;

  constructor(message: string, databaseReplaced: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FullRestoreError";
    this.databaseReplaced = databaseReplaced;
  }
}

export interface FullRestoreOptions {
  /** Path of the `.bvb` archive. */
  file: string;
  passphrase: string;
  /** Where the uploads root is read from (`IMAGE_UPLOAD_DIR`). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * The backup folder, whose full-backup lock this run holds from before it
   * stages anything until it ends: a backup made during a restore would
   * archive a half-restored install (and `--keep` could then delete an older
   * good one). Defaults to the folder the archive is in.
   */
  dir?: string;
  /** Used for the folder names when `stamp` is not given. Defaults to now. */
  now?: Date;
  /**
   * `<ts>` in `.restore-<ts>` / `.pre-restore-<ts>`, as `YYYYmmdd-HHMMSS`
   * (optionally `-<n>`). restore.sh passes its own, so that its rollback
   * knows which folders belong to this run.
   */
  stamp?: string;
}

export interface FullRestoreResult {
  /** The archive's file name. */
  file: string;
  /** Uploaded files restored, and their total plaintext size. */
  files: number;
  bytes: number;
  /** Rows written per backup key. */
  counts: Record<string, number>;
  /** Name of the folder (inside the uploads root) that now holds the previous `images/` and `documents/`. */
  preRestore: string;
  /** Things that went wrong after the restore was complete. Empty on a normal run. */
  warnings: string[];
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Where a `files/...` entry goes under the staging folder, as path segments
 * — or a refusal. The rule is ./entry-names.ts's, shared with the backup
 * walk and with `verifyFullBackup`: a backup never holds a name
 * this refuses, and one that does fails its verify first.
 */
function stagedSegments(names: EntryNameSet, entryPath: string): string[] {
  const refusal = names.add(entryPath);
  if (refusal) throw new FullRestoreError(`The backup holds a file that cannot be restored: "${printableName(entryPath)}" (${refusal}). Nothing was changed.`, false);
  return entryPath.slice("files/".length).split("/");
}

const printable = printableName;

async function readWhole(body: Readable, size: number, what: string): Promise<Buffer> {
  if (size > MAX_ENTRY_BYTES) throw new FullRestoreError(`${what} is too large to restore (${size} bytes). Nothing was changed.`, false);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
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

async function lstatOrNull(p: string) {
  try {
    return await fsp.lstat(p);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return null;
    throw e;
  }
}

/**
 * Restores the archive at `opts.file`. Resolves once the records and the
 * uploads are in place and audited. Rejects with
 * - `SealError` (wrong passphrase; damaged, truncated or unsupported
 *   archive), `FullBackupVerifyError` / `ManifestError` (contents and manifest
 *   disagree), a tar error, or `FullRestoreError` with
 *   `databaseReplaced: false` — refused before any change; the staging folder
 *   is gone;
 * - `FullRestoreError` with `databaseReplaced: true` — the records were
 *   replaced and a later step failed; the uploads were put back as they
 *   were, the database needs the snapshot.
 * Any other error (ENOSPC while staging, a missing key) also means nothing
 * was changed: everything that can fail after the commit is wrapped.
 */
export async function runFullRestore(opts: FullRestoreOptions): Promise<FullRestoreResult> {
  const env = opts.env ?? process.env;
  const stamp = opts.stamp ?? snapshotStamp(opts.now ?? new Date());
  if (!RESTORE_STAMP.test(stamp)) throw new FullRestoreError("The restore stamp must look like 20261003-120000. Nothing was changed.", false);
  const file = path.resolve(opts.file);
  const fileName = path.basename(file);
  const root = uploadsRoot(env);
  const staging = path.join(root, `${RESTORE_STAGING_PREFIX}${stamp}`);
  const preRestoreName = `${PRE_RESTORE_PREFIX}${stamp}`;
  const preRestore = path.join(root, preRestoreName);
  const marker = path.join(root, dbStepMarkerName(stamp));

  // The key must load before anything is staged (EncryptionKeyError otherwise).
  getFieldKeys();

  // Nothing below may start if this run's folders are already there, or if a
  // live folder is not a plain folder (a link would be renamed, not its target).
  await fsp.mkdir(root, { recursive: true });
  for (const leftover of [preRestore, marker]) {
    if (await lstatOrNull(leftover)) {
      throw new FullRestoreError(`${leftover} already exists (left by an earlier restore). Move it away first. Nothing was changed.`, false);
    }
  }
  for (const { dir } of UPLOAD_FOLDERS) {
    const stat = await lstatOrNull(path.join(root, dir));
    if (stat && !stat.isDirectory()) {
      throw new FullRestoreError(`${path.join(root, dir)} is not a folder (a link, or a file). Replace it with a real folder first. Nothing was changed.`, false);
    }
  }
  // No backup may run while the install is being replaced, and no restore
  // while a backup is being made (FullBackupAlreadyRunningError: nothing was changed).
  const lock = await acquireFullBackupLock(path.resolve(opts.dir ?? path.dirname(file)));

  try {
    const result = await restoreLocked({ opts, stamp, file, fileName, root, staging, preRestoreName, preRestore, marker });
    // The lock's warnings: the heartbeat could not keep the lock fresh on this folder.
    result.warnings.push(...lock.warnings());
    return result;
  } finally {
    await lock.release();
  }
}

interface RestorePaths {
  opts: FullRestoreOptions;
  stamp: string;
  file: string;
  fileName: string;
  root: string;
  staging: string;
  preRestoreName: string;
  preRestore: string;
  marker: string;
}

/** Steps 1–5 of the restore, with the lock held and the pre-flight checks passed. */
async function restoreLocked({ opts, file, fileName, root, staging, preRestoreName, preRestore, marker }: RestorePaths): Promise<FullRestoreResult> {
  let databaseReplaced = false;
  const renamed: Array<{ from: string; to: string }> = [];
  const createdLive: string[] = [];
  let createdPreRestore = false;

  // Staging left by a restore that was killed holds only copies of an archive's files.
  // An earlier run's database-step marker is NOT staging and is never removed here.
  for (const name of await fsp.readdir(root)) {
    if (name.startsWith(RESTORE_STAGING_PREFIX) && !name.endsWith(DB_STEP_MARKER_SUFFIX)) await fsp.rm(path.join(root, name), { recursive: true, force: true });
  }

  try {
    // ── 1. Stage ────────────────────────────────────────────────
    await fsp.mkdir(staging, { mode: 0o700 });
    for (const { dir } of UPLOAD_FOLDERS) await fsp.mkdir(path.join(staging, dir));

    const opener = createBackupOpener(opts.passphrase);
    const input = createReadStream(file);
    pipeline(input, opener, () => undefined);

    const staged = new Map<string, { size: number; sha256: string }>();
    const names = new EntryNameSet();
    let dbBytes: Buffer | null = null;
    let manifest: Manifest | null = null;

    await readTar(opener, async (entryPath, size, body) => {
      if (manifest) {
        throw new FullRestoreError(`"${printable(entryPath)}" comes after manifest.json, which must be the last entry. Nothing was changed.`, false);
      }
      if (entryPath === MANIFEST_ENTRY) {
        // Checked against the DECLARED size, before a single byte is buffered.
        if (size > MAX_MANIFEST_BYTES) throw new FullRestoreError(`manifest.json is too large (${size} bytes). Nothing was changed.`, false);
        manifest = parseManifest(await readWhole(body, size, MANIFEST_ENTRY));
        return;
      }
      if (entryPath === DB_ENTRY) {
        dbBytes = await readWhole(body, size, DB_ENTRY);
        return;
      }
      const segments = stagedSegments(names, entryPath);
      const plaintext = await readWhole(body, size, entryPath);
      const target = path.join(staging, ...segments);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await writeEncryptedFile(target, plaintext);
      staged.set(entryPath, { size: plaintext.length, sha256: createHash("sha256").update(plaintext).digest("hex") });
    });

    // ── 2. Check: only now is the stream known to be complete ───
    const m = manifest as Manifest | null;
    const db = dbBytes as Buffer | null;
    if (!m) throw new FullRestoreError("The backup has no manifest.json. Nothing was changed.", false);
    if (!db) throw new FullRestoreError("The backup has no db.json. Nothing was changed.", false);
    const bytes = checkEntriesAgainstManifest(staged, m);
    checkDbAgainstCounts(db, m.counts);
    const payload: unknown = JSON.parse(db.toString("utf8"));
    // Everything the shared restore logic can refuse WITHOUT writing (not a
    // backup payload, a legacy value that cannot be read) is refused here,
    // before the marker: a marker tells the wrapper to put the database back
    // from its snapshot, and nothing has touched the database yet.
    const prepared = await prepareBackupRestore(payload, { logLabel: "full-restore", transactionTimeoutMs: FULL_RESTORE_TRANSACTION_TIMEOUT_MS });
    if (!prepared.ok) throw new FullRestoreError(`${prepared.error} Nothing was changed.`, false);

    // ── 3. Database: one transaction, through the shared restore logic ──
    // The marker first, durable before the transaction opens.
    await fsp.mkdir(marker, { mode: 0o700 });
    const started = await fsp.open(path.join(marker, "started"), "wx", 0o600);
    try {
      await started.sync();
    } finally {
      await started.close();
    }
    await fsyncDir(marker);
    await fsyncDir(root);
    const restored = await prepared.write();
    if (!restored.ok) throw new FullRestoreError(`${restored.error} Nothing was changed.`, false);
    databaseReplaced = true;

    // ── 4. Folders ──────────────────────────────────────────────
    await fsp.mkdir(preRestore, { mode: 0o700 });
    createdPreRestore = true;
    for (const { dir } of UPLOAD_FOLDERS) {
      const live = path.join(root, dir);
      // A missing live folder is created first, so that the previous state
      // of BOTH folders is always inside .pre-restore-<ts>: a rollback then
      // needs no other record of what was there.
      if (!(await lstatOrNull(live))) {
        await fsp.mkdir(live);
        createdLive.push(live);
      }
      const kept = path.join(preRestore, dir);
      await fsp.rename(live, kept);
      renamed.push({ from: live, to: kept });
      const stagedDir = path.join(staging, dir);
      await fsp.rename(stagedDir, live);
      renamed.push({ from: stagedDir, to: live });
    }
    await fsyncDir(root);

    // From here on the restore is complete. Nothing below may fail it.
    const warnings: string[] = [];
    try {
      await fsp.rm(marker, { recursive: true });
      await fsyncDir(root);
    } catch (e) {
      // Not a detail: the app's start refuses while any marker exists
      // (assertNoUnfinishedRestore in ../files/startup.ts).
      warnings.push(
        `The restore finished, but its marker ${marker} could not be removed (${codeOf(e) ?? messageOf(e)}). ` +
          "BlackVault refuses to start while that marker exists. restore.sh and restore.bat remove it before they start " +
          "BlackVault; if you ran this program yourself, delete that folder before you start BlackVault.",
      );
    }
    try {
      await fsp.rmdir(staging);
    } catch (e) {
      warnings.push(`The restore finished, but the empty work folder ${staging} could not be removed (${codeOf(e) ?? messageOf(e)}). It can be deleted.`);
    }

    await recordEventBestEffort(null, {
      action: "RESTORE",
      entityLabel: fileName,
      changes: { full: true, file: fileName, files: m.files.length },
    });

    return { file: fileName, files: m.files.length, bytes, counts: restored.counts, preRestore: preRestoreName, warnings };
  } catch (e) {
    // Undo, newest first: staged folders back out, the previous folders back in.
    const undoFailures: string[] = [];
    for (const { from, to } of [...renamed].reverse()) {
      try {
        await fsp.rename(to, from);
      } catch (undoError) {
        undoFailures.push(`${to} could not be moved back to ${from} (${codeOf(undoError) ?? messageOf(undoError)})`);
      }
    }
    if (undoFailures.length === 0) {
      for (const live of createdLive) await fsp.rmdir(live).catch(() => undefined);
      if (createdPreRestore) await fsp.rmdir(preRestore).catch(() => undefined);
    }
    await fsp.rm(staging, { recursive: true, force: true }).catch((rmError) => {
      undoFailures.push(`the work folder ${staging} could not be removed (${codeOf(rmError) ?? messageOf(rmError)})`);
    });

    if (!databaseReplaced && undoFailures.length === 0) throw e;
    const uploads =
      undoFailures.length === 0
        ? "The photos and documents were put back as they were."
        : `The photos and documents could NOT be put back completely: ${undoFailures.join("; ")}.`;
    const database = databaseReplaced
      ? "The database records were already replaced and must be restored from the snapshot."
      : "The database was not changed.";
    throw new FullRestoreError(`${messageOf(e)} ${database} ${uploads}`, databaseReplaced, { cause: e });
  }
}
