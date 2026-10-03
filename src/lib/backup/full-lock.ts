import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

/**
 * The full-backup lock (spec 3c §2 step 1): `<backup folder>/.full-backup.lock`,
 * holding the owner's pid and start time. One lock for every way a full
 * backup can start — the CLI engine (`scripts/entry/full-backup.ts`, exit 2
 * when it is taken) and the Settings button's in-process job (HTTP 409) —
 * so both callers tell "already running" apart from every other failure by
 * `instanceof FullBackupAlreadyRunningError`, never by message text.
 *
 * Liveness is "is that pid running": a lock whose pid is dead is stale and is
 * reclaimed. Two refinements:
 * - a lock carrying THIS process's pid is live only if this process really
 *   holds it (tracked in `held`). A container that crashed mid-backup comes
 *   back with the same pid (the app is usually pid 1), so "the pid is alive"
 *   alone would make that leftover lock permanent;
 * - a lock file that cannot be parsed (empty, cut short by a crash) has no
 *   owner to check, and is treated as stale.
 *
 * Known limits (a pid check cannot do better): a pid recycled by an unrelated
 * process keeps a stale lock alive until that process exits, and two
 * processes that both find the SAME stale lock in the same instant can both
 * reclaim it. The create itself is exclusive (`wx`), so two starters with no
 * stale lock present can never both win.
 */

/** The backup folder inside the container (compose mounts BLACKVAULT_BACKUP_DIR there). Lives here, not in full-backup.ts, so the CLI can name it without loading the database client. */
export const DEFAULT_FULL_BACKUP_DIR = "/app/backups";

export const FULL_BACKUP_LOCK_NAME = ".full-backup.lock";

/** Another full backup holds the lock. CLI: exit 2. Settings button: HTTP 409. */
export class FullBackupAlreadyRunningError extends Error {
  readonly code = "ALREADY_RUNNING" as const;
  /** The holder's pid and start time, as written in the lock file. */
  readonly pid: number;
  readonly startedAt: string;

  constructor(pid: number, startedAt: string) {
    super(`Another full backup is already running (pid ${pid}, started ${startedAt}).`);
    this.name = "FullBackupAlreadyRunningError";
    this.pid = pid;
    this.startedAt = startedAt;
  }
}

export interface FullBackupLock {
  /** The lock file's absolute path. */
  readonly path: string;
  /** Removes the lock if it is still ours. Safe to call more than once; never throws. */
  release(): Promise<void>;
}

interface LockBody {
  pid: number;
  startedAt: string;
  token: string;
}

/** Locks this process holds right now: lock path -> token. */
const held = new Map<string, string>();

function parseLock(text: string): LockBody | null {
  try {
    const body = JSON.parse(text) as Partial<LockBody> | null;
    if (!body || typeof body.pid !== "number" || !Number.isInteger(body.pid) || body.pid <= 0) return null;
    return {
      pid: body.pid,
      startedAt: typeof body.startedAt === "string" ? body.startedAt : "unknown",
      token: typeof body.token === "string" ? body.token : "",
    };
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isLive(lockPath: string, body: LockBody): boolean {
  if (body.pid === process.pid) return held.get(lockPath) === body.token;
  return pidIsAlive(body.pid);
}

async function createExclusive(lockPath: string, text: string): Promise<boolean> {
  let handle;
  try {
    handle = await fsp.open(lockPath, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
    throw e;
  }
  await handle.close();
  return true;
}

/**
 * Takes the full-backup lock in `dir`. Rejects with
 * FullBackupAlreadyRunningError when a live backup holds it; with the
 * underlying fs error (ENOENT, EACCES, ...) when the folder is missing or not
 * writable.
 */
export async function acquireFullBackupLock(dir: string): Promise<FullBackupLock> {
  const lockPath = path.join(path.resolve(dir), FULL_BACKUP_LOCK_NAME);
  const token = randomBytes(8).toString("hex");
  const text = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token });

  // Two rounds: create; if it exists and is stale, remove it and create once
  // more. Losing the second create means someone else took it in between.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createExclusive(lockPath, text)) {
      held.set(lockPath, token);
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          if (held.get(lockPath) === token) held.delete(lockPath);
          try {
            const current = parseLock(await fsp.readFile(lockPath, "utf8"));
            if (current?.token === token && current.pid === process.pid) await fsp.rm(lockPath, { force: true });
          } catch {
            // Already gone, or unreadable: nothing of ours to remove.
          }
        },
      };
    }

    let existing: string;
    try {
      existing = await fsp.readFile(lockPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue; // released between the two calls
      throw e;
    }
    const body = parseLock(existing);
    if (body && isLive(lockPath, body)) throw new FullBackupAlreadyRunningError(body.pid, body.startedAt);
    if (attempt === 0) await fsp.rm(lockPath, { force: true });
  }

  const now = parseLock(await fsp.readFile(lockPath, "utf8").catch(() => ""));
  throw new FullBackupAlreadyRunningError(now?.pid ?? 0, now?.startedAt ?? "unknown");
}
