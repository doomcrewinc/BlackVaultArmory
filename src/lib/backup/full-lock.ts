import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The full-backup lock (spec 3c §2 step 1): `<backup folder>/.full-backup.lock`.
 * One lock for every way a full backup can start — the CLI engine
 * (`scripts/entry/full-backup.ts`, exit 2 when it is taken) and the Settings
 * button's in-process job (HTTP 409) — so both callers tell "already running"
 * apart from every other failure by `instanceof FullBackupAlreadyRunningError`,
 * never by message text.
 *
 * The file holds the owner's pid, start time and HOSTNAME, and the owner
 * refreshes its mtime every 30 s (the heartbeat) for as long as it holds it.
 *
 * Is an existing lock live? (ruling R10)
 * - Same hostname: the pid decides. A dead pid is reclaimed at once. A lock
 *   carrying THIS process's pid is live only if this process really holds it
 *   (`held`): a container that crashed mid-backup restarts with the same
 *   hostname and the same pid, so "the pid is alive" alone would make its
 *   leftover lock permanent.
 * - Different hostname: a pid means nothing across containers (the app and a
 *   `docker compose run` CLI are both pid 1 in their own namespaces), so only
 *   the heartbeat decides: live unless the mtime is older than 5 minutes.
 * - No usable owner — unparseable, empty, or written without a hostname: also
 *   judged by the heartbeat alone. This is deliberate, not a fallback: the
 *   lock is created and then written, so a contender can see a live holder's
 *   file while it is still empty. Treating that as stale would let two
 *   backups run (the first version of this file did, and a 25-way race test
 *   caught it). The price is that a lock cut short by a crash blocks backups
 *   for up to 5 minutes.
 *
 * Reclaiming a stale lock is serialised by a second exclusive file,
 * `.full-backup.lock.reclaim`: only its holder may replace the stale lock,
 * it re-judges the lock after taking the guard, and it replaces it with one
 * atomic rename — the lock path is never empty in between, so a plain
 * create (`wx`) cannot slip in. Of any number of contenders exactly one wins.
 *
 * Known limits: a pid recycled by an unrelated process on the same host keeps
 * a stale lock alive until that process exits; the heartbeat rule compares
 * the file's mtime with this machine's clock, so on a network share a clock
 * difference of minutes between the file server and this host shifts the
 * 5-minute threshold by that much.
 */

/** The backup folder inside the container (compose mounts BLACKVAULT_BACKUP_DIR there). Lives here, not in full-backup.ts, so the CLI can name it without loading the database client. */
export const DEFAULT_FULL_BACKUP_DIR = "/app/backups";

export const FULL_BACKUP_LOCK_NAME = ".full-backup.lock";
/** How often the holder refreshes the lock file's mtime. */
export const FULL_BACKUP_LOCK_HEARTBEAT_MS = 30_000;
/** A lock whose owner cannot be checked by pid is stale once its mtime is older than this. */
export const FULL_BACKUP_LOCK_STALE_MS = 5 * 60_000;
const RECLAIM_GUARD_SUFFIX = ".reclaim";

/** Another full backup holds the lock. CLI: exit 2. Settings button: HTTP 409. */
export class FullBackupAlreadyRunningError extends Error {
  readonly code = "ALREADY_RUNNING" as const;
  /** The holder, as written in the lock file. `pid` 0 / `"unknown"` when the file names none. */
  readonly pid: number;
  readonly startedAt: string;
  readonly hostname: string;

  constructor(holder: { pid: number; startedAt: string; hostname: string }) {
    super(
      holder.pid > 0
        ? `Another full backup is already running (pid ${holder.pid} on ${holder.hostname}, started ${holder.startedAt}).`
        : "Another full backup is already running.",
    );
    this.name = "FullBackupAlreadyRunningError";
    this.pid = holder.pid;
    this.startedAt = holder.startedAt;
    this.hostname = holder.hostname;
  }
}

export interface FullBackupLockOptions {
  /** Heartbeat interval. Default 30 s. */
  heartbeatMs?: number;
  /** Heartbeat age after which a lock from another host (or with no usable owner) is stale. Default 5 minutes. */
  staleMs?: number;
  /** This machine's name, written into the lock and compared with an existing one. Default `os.hostname()`. */
  hostname?: string;
}

export interface FullBackupLock {
  /** The lock file's absolute path. */
  readonly path: string;
  /** Stops the heartbeat and removes the lock if it is still ours. Safe to call more than once; never throws. */
  release(): Promise<void>;
}

interface LockBody {
  pid: number;
  startedAt: string;
  hostname: string | null;
  token: string;
}

/** Locks this process holds right now: lock path -> token. */
const held = new Map<string, string>();

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

function parseLock(text: string): LockBody | null {
  try {
    const body = JSON.parse(text) as Partial<LockBody> | null;
    if (!body || typeof body.pid !== "number" || !Number.isInteger(body.pid) || body.pid <= 0) return null;
    return {
      pid: body.pid,
      startedAt: typeof body.startedAt === "string" ? body.startedAt : "unknown",
      hostname: typeof body.hostname === "string" && body.hostname.length > 0 ? body.hostname : null,
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
    return codeOf(e) === "EPERM";
  }
}

type Verdict = { state: "gone" } | { state: "live" | "stale"; body: LockBody | null };

/** Reads the lock and applies the liveness rule in the module comment. */
async function judge(lockPath: string, hostname: string, staleMs: number): Promise<Verdict> {
  let text: string;
  let mtimeMs: number;
  try {
    // mtime first: a heartbeat landing between the two calls can only make the lock look older, never fresher.
    mtimeMs = (await fsp.stat(lockPath)).mtimeMs;
    text = await fsp.readFile(lockPath, "utf8");
  } catch (e) {
    if (codeOf(e) === "ENOENT") return { state: "gone" };
    throw e;
  }
  const body = parseLock(text);
  let live: boolean;
  if (body && body.hostname === hostname) {
    live = body.pid === process.pid ? held.get(lockPath) === body.token : pidIsAlive(body.pid);
  } else {
    live = Date.now() - mtimeMs <= staleMs;
  }
  return { state: live ? "live" : "stale", body };
}

function alreadyRunning(body: LockBody | null): FullBackupAlreadyRunningError {
  return new FullBackupAlreadyRunningError({
    pid: body?.pid ?? 0,
    startedAt: body?.startedAt ?? "unknown",
    hostname: body?.hostname ?? "unknown",
  });
}

/** Creates `file` exclusively, mode 0600, holding `text`. False when it already exists. */
async function createExclusive(file: string, text: string): Promise<boolean> {
  let handle;
  try {
    handle = await fsp.open(file, "wx", 0o600);
  } catch (e) {
    if (codeOf(e) === "EEXIST") return false;
    throw e;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => undefined);
    await fsp.rm(file, { force: true }).catch(() => undefined);
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
export async function acquireFullBackupLock(dir: string, opts: FullBackupLockOptions = {}): Promise<FullBackupLock> {
  const heartbeatMs = opts.heartbeatMs ?? FULL_BACKUP_LOCK_HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? FULL_BACKUP_LOCK_STALE_MS;
  const hostname = opts.hostname ?? os.hostname();
  const lockPath = path.join(path.resolve(dir), FULL_BACKUP_LOCK_NAME);
  const guardPath = lockPath + RECLAIM_GUARD_SUFFIX;
  const token = randomBytes(8).toString("hex");
  const text = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname, token });

  const hold = (): FullBackupLock => {
    held.set(lockPath, token);
    const isOurs = async (): Promise<boolean> => {
      const current = parseLock(await fsp.readFile(lockPath, "utf8"));
      return current?.token === token && current.pid === process.pid;
    };
    // The heartbeat. unref'd: a held lock never keeps the process alive.
    const timer = setInterval(() => {
      void (async () => {
        try {
          // Never refresh a lock someone else reclaimed after a long stall of ours.
          if (!(await isOurs())) return;
          const now = new Date();
          await fsp.utimes(lockPath, now, now);
        } catch {
          // Gone or unreadable: nothing to refresh.
        }
      })();
    }, heartbeatMs);
    timer.unref();

    let released = false;
    return {
      path: lockPath,
      async release() {
        if (released) return;
        released = true;
        clearInterval(timer);
        if (held.get(lockPath) === token) held.delete(lockPath);
        try {
          if (await isOurs()) await fsp.rm(lockPath, { force: true });
        } catch {
          // Already gone, or unreadable: nothing of ours to remove.
        }
      },
    };
  };

  let last: LockBody | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(lockPath, text)) return hold();

    const verdict = await judge(lockPath, hostname, staleMs);
    if (verdict.state === "gone") continue; // released between the two calls: try the create again
    last = verdict.body;
    if (verdict.state === "live") throw alreadyRunning(verdict.body);

    // Stale. Only the holder of the reclaim guard may replace it.
    if (!(await createExclusive(guardPath, ""))) {
      const guardAge = await fsp.stat(guardPath).then((s) => Date.now() - s.mtimeMs, () => null);
      // No guard any more (the other reclaimer just finished): look again.
      if (guardAge === null) continue;
      // Someone is reclaiming right now: they, or whoever they find, hold the lock.
      if (guardAge <= staleMs) throw alreadyRunning(verdict.body);
      // A reclaimer died holding the guard, long ago.
      await fsp.rm(guardPath, { force: true });
      continue;
    }
    const tmpPath = `${lockPath}.${token}.tmp`;
    try {
      // Judged again now that no one else can be reclaiming.
      const again = await judge(lockPath, hostname, staleMs);
      if (again.state === "live") throw alreadyRunning(again.body);
      if (again.state === "gone") continue; // nothing to replace; a plain create decides
      if (!(await createExclusive(tmpPath, text))) throw new Error(`full-backup lock: ${tmpPath} already exists`);
      await fsp.rename(tmpPath, lockPath); // atomic: the stale lock becomes ours
      return hold();
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      await fsp.rm(guardPath, { force: true }).catch(() => undefined);
    }
  }

  throw alreadyRunning(last);
}
