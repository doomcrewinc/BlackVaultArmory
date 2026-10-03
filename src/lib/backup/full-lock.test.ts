import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireFullBackupLock, FULL_BACKUP_LOCK_NAME, FullBackupAlreadyRunningError } from "./full-lock";

let dir: string;
const lockPath = () => path.join(dir, FULL_BACKUP_LOCK_NAME);

/** A pid that existed and has exited: nothing is running under it now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 30_000 });
  expect(child.status).toBe(0);
  return child.pid;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bv-full-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireFullBackupLock", () => {
  it("is named .full-backup.lock, holds this pid and a start time, and is mode 0600", async () => {
    expect(FULL_BACKUP_LOCK_NAME).toBe(".full-backup.lock");
    const before = Date.now();
    const lock = await acquireFullBackupLock(dir);
    const body = JSON.parse(readFileSync(lockPath(), "utf8"));
    expect(body.pid).toBe(process.pid);
    expect(Date.parse(body.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    if (process.platform !== "win32") expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    await lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("a second acquire while the first is held fails with FullBackupAlreadyRunningError, and works again after release", async () => {
    const first = await acquireFullBackupLock(dir);
    const second = acquireFullBackupLock(dir);
    await expect(second).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
    await expect(second).rejects.toMatchObject({ code: "ALREADY_RUNNING", pid: process.pid });
    // The failed attempt must not have damaged the holder's lock.
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    await first.release();
    const third = await acquireFullBackupLock(dir);
    await third.release();
  });

  it("a lock held by ANOTHER live process is respected", async () => {
    // The vitest parent process: alive for the whole run, and not this worker.
    writeFileSync(lockPath(), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), token: "other" }));
    await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).token).toBe("other");
  });

  it("a stale lock with a dead pid is reclaimed", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", token: "stale" }));
    const lock = await acquireFullBackupLock(dir);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("a lock carrying THIS pid that this process does not hold is stale (a restarted container reuses its pid)", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", token: "previous-run" }));
    const lock = await acquireFullBackupLock(dir);
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).token).not.toBe("previous-run");
    await lock.release();
  });

  it("an unreadable (garbage or empty) lock file is treated as stale and reclaimed", async () => {
    writeFileSync(lockPath(), "not json");
    const lock = await acquireFullBackupLock(dir);
    await lock.release();
    writeFileSync(lockPath(), "");
    const again = await acquireFullBackupLock(dir);
    await again.release();
  });

  it("release is idempotent and never removes a lock that is not ours", async () => {
    const lock = await acquireFullBackupLock(dir);
    await lock.release();
    await lock.release();
    const other = await acquireFullBackupLock(dir);
    await lock.release(); // the first handle again: must not delete `other`'s lock
    expect(existsSync(lockPath())).toBe(true);
    await other.release();
  });

  it("a missing backup folder fails with an error (not 'already running')", async () => {
    const err = await acquireFullBackupLock(path.join(dir, "nope")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FullBackupAlreadyRunningError);
  });
});
