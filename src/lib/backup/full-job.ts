import { randomUUID } from "crypto";
import { runFullBackup, type FullBackupProgress, type FullBackupResult, type FullBackupSkipped } from "./full-backup";
import { acquireFullBackupLock, DEFAULT_FULL_BACKUP_DIR, FullBackupAlreadyRunningError } from "./full-lock";

/**
 * The Settings button's full backup, as one in-process background job
 * (full-backups spec §2 "Settings button").
 *
 * - One job at a time. The state lives on `globalThis` so Next's dev-mode
 *   module reloads (and route bundles that each import this file) share it.
 * - The job outlives the request that started it. The passphrase is only ever
 *   an argument to `runFullBackup`: it is NOT a field of the job state, so it
 *   cannot reach the status endpoint, and nothing here keeps it once the run's
 *   promise settles.
 * - The last job's snapshot stays readable until the next job starts, so a
 *   page opened after a run finished still shows what happened.
 */

export type FullBackupJobState = "idle" | "running" | "succeeded" | "failed";

export interface FullBackupStatus {
  /** Absent until the first job of this server process. */
  jobId?: string;
  state: FullBackupJobState;
  /** Which phase the counters belong to. Their units differ between phases (see FullBackupProgress). */
  phase?: FullBackupProgress["phase"];
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** On success: the archive's file name in the server's backup folder. */
  file?: string;
  /** On success: uploaded files in the archive, their plaintext size, and what was left out. */
  files?: number;
  bytes?: number;
  skipped?: FullBackupSkipped[];
  warnings?: string[];
  /** On failure. */
  error?: string;
}

/** This process already has a backup job in progress. */
export class FullBackupJobBusyError extends Error {
  constructor() {
    super("A full backup is already running.");
    this.name = "FullBackupJobBusyError";
  }
}

interface JobStore {
  status: FullBackupStatus;
}

const STORE_KEY = "__blackvaultFullBackupJob";
const globalForJob = globalThis as unknown as Record<string, JobStore | undefined>;

function store(): JobStore {
  return (globalForJob[STORE_KEY] ??= { status: idle() });
}

function idle(): FullBackupStatus {
  return { state: "idle", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
}

/** A copy, so callers cannot mutate the job's state. */
export function getFullBackupStatus(): FullBackupStatus {
  return structuredClone(store().status);
}

/** Tests only. */
export function resetFullBackupJobForTests(): void {
  globalForJob[STORE_KEY] = undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "The backup failed.";
}

export interface StartFullBackupOptions {
  /** Validated by the caller. Never stored. */
  passphrase: string;
  /** Resolved before the job starts: the job outlives the request, and resolving a user inside a transaction deadlocks SQLite. */
  actor: { actorId: string | null; actorName: string };
  dir?: string;
}

/**
 * Starts a job and returns its id without waiting for it.
 * Throws `FullBackupJobBusyError` if this process has a job running, and
 * `FullBackupAlreadyRunningError` if another process (backup.sh) holds the
 * engine's lock. A lock lost to another process after this check surfaces as a
 * failed job instead (the engine takes the lock itself).
 */
export async function startFullBackupJob(opts: StartFullBackupOptions): Promise<{ jobId: string }> {
  const s = store();
  if (s.status.state === "running") throw new FullBackupJobBusyError();

  // Claim the slot synchronously (no await before this), so two simultaneous
  // requests cannot both pass the check above.
  const previous = s.status;
  const jobId = randomUUID();
  s.status = { ...idle(), jobId, state: "running" };

  const dir = opts.dir ?? DEFAULT_FULL_BACKUP_DIR;
  try {
    // Probe the engine's lock so the caller can answer 409 instead of 202. Any
    // other problem (folder missing or not writable) is left to the run, which
    // reports it with the folder named.
    const probe = await acquireFullBackupLock(dir).catch((e: unknown) => {
      if (e instanceof FullBackupAlreadyRunningError) throw e;
      return null;
    });
    await probe?.release();
  } catch (e) {
    s.status = previous;
    throw e;
  }

  const mine = s.status;
  const update = (patch: Partial<FullBackupStatus>) => {
    // A stale callback from a finished job must never touch a newer one.
    if (s.status === mine) Object.assign(mine, patch);
  };

  const done = (result: FullBackupResult) =>
    update({
      state: "succeeded",
      file: result.file,
      files: result.files,
      bytes: result.bytes,
      skipped: result.skipped.map((x) => ({ ...x })),
      warnings: [...result.warnings],
    });

  // Detached on purpose: the request returns now. Both outcomes are handled,
  // so there is no unhandled rejection to take the server down.
  void runFullBackup({
    passphrase: opts.passphrase,
    dir,
    actor: opts.actor,
    onProgress: (p) => update({ phase: p.phase, filesDone: p.filesDone, filesTotal: p.filesTotal, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal }),
  }).then(done, (e: unknown) => {
    console.error("[full-backup] job failed:", messageOf(e));
    update({ state: "failed", error: messageOf(e) });
  });

  return { jobId };
}
