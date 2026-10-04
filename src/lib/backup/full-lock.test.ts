import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireFullBackupLock,
  FULL_BACKUP_LOCK_HEARTBEAT_MS,
  FULL_BACKUP_LOCK_NAME,
  FULL_BACKUP_LOCK_STALE_MS,
  FullBackupAlreadyRunningError,
  fullBackupLockStatus,
  type FullBackupLock,
} from "./full-lock";

let dir: string;
const open: FullBackupLock[] = [];
const lockPath = () => path.join(dir, FULL_BACKUP_LOCK_NAME);
const HOST = os.hostname();
const OTHER_HOST = "some-other-container";

/** A pid that existed and has exited: nothing is running under it now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 30_000 });
  expect(child.status).toBe(0);
  return child.pid;
}

/** Plants a lock file as some other holder would have left it; `ageMs` back-dates its heartbeat (mtime). */
function plant(body: unknown, ageMs = 0): void {
  writeFileSync(lockPath(), typeof body === "string" ? body : JSON.stringify(body));
  if (ageMs) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(lockPath(), then, then);
  }
}

async function acquire(...args: Parameters<typeof acquireFullBackupLock>): Promise<FullBackupLock> {
  const lock = await acquireFullBackupLock(...args);
  open.push(lock);
  return lock;
}

const body = () => JSON.parse(readFileSync(lockPath(), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bv-full-lock-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lock of open.splice(0)) await lock.release();
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireFullBackupLock", () => {
  it("defaults: heartbeat every 30 s, stale after 5 minutes", () => {
    expect(FULL_BACKUP_LOCK_HEARTBEAT_MS).toBe(30_000);
    expect(FULL_BACKUP_LOCK_STALE_MS).toBe(5 * 60_000);
  });

  it("is named .full-backup.lock, holds pid + startedAt + hostname, and is mode 0600", async () => {
    expect(FULL_BACKUP_LOCK_NAME).toBe(".full-backup.lock");
    const before = Date.now();
    const lock = await acquire(dir);
    expect(body().pid).toBe(process.pid);
    expect(body().hostname).toBe(HOST);
    expect(Date.parse(body().startedAt)).toBeGreaterThanOrEqual(before - 1000);
    if (process.platform !== "win32") expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    await lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  // A FAT/exFAT disk or a share mounted for another uid: the app can create
  // and write the lock but may not chmod it. The lock holds nothing secret.
  it.each(["EPERM", "ENOTSUP"])("a folder that refuses chmod (%s) still gives the lock, and it still excludes a second run", async (code) => {
    const realOpen = fsp.open.bind(fsp);
    let chmods = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      (handle as unknown as { chmod: unknown }).chmod = async () => {
        chmods += 1;
        throw Object.assign(new Error(`${code}: operation not permitted, fchmod`), { code, syscall: "fchmod" });
      };
      return handle;
    }) as typeof fsp.open);
    const lock = await acquire(dir);
    expect(chmods).toBe(1);
    expect(body()).toMatchObject({ pid: process.pid, hostname: HOST });
    await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
    await lock.release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("any other chmod failure (EIO) fails the acquire and leaves no lock file", async () => {
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      (handle as unknown as { chmod: unknown }).chmod = async () => {
        throw Object.assign(new Error("EIO: i/o error, fchmod"), { code: "EIO", syscall: "fchmod" });
      };
      return handle;
    }) as typeof fsp.open);
    await expect(acquireFullBackupLock(dir)).rejects.toMatchObject({ code: "EIO" });
    expect(readdirSync(dir)).toEqual([]);
  });

  // Ruling R34. Where the app does not own the lock file (a FAT disk or a share
  // mounted for another uid), utimes with explicit times can be refused. The
  // heartbeat must still keep the lock fresh, or it looks stale after 5 minutes.
  describe("heartbeat when utimes is refused (R34)", () => {
    const refuseUtimes = () =>
      vi.spyOn(fsp, "utimes").mockImplementation((async () => {
        throw Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM", syscall: "utime" });
      }) as typeof fsp.utimes);
    const backdate = () => {
      const then = new Date(Date.now() - 60 * 60_000);
      utimesSync(lockPath(), then, then);
    };
    const ageMs = () => Date.now() - statSync(lockPath()).mtimeMs;

    it("falls back to rewriting the lock file in place: its mtime advances, its content is unchanged, and there is no warning", async () => {
      const utimes = refuseUtimes();
      const lock = await acquire(dir, { heartbeatMs: 25 });
      const before = readFileSync(lockPath(), "utf8");
      backdate();
      expect(ageMs()).toBeGreaterThan(30 * 60_000);
      await sleep(300);
      expect(utimes).toHaveBeenCalled();
      expect(ageMs()).toBeLessThan(10_000);
      expect(readFileSync(lockPath(), "utf8")).toBe(before);
      expect(lock.warnings()).toEqual([]);
    });

    it("when the rewrite is refused too, ONE warning says another backup or restore may not see this one as running", async () => {
      refuseUtimes();
      const lock = await acquire(dir, { heartbeatMs: 25 });
      const realOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]) === lockPath() && args[1] === "r+") throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES", syscall: "open" });
        return realOpen(...args);
      }) as typeof fsp.open);
      backdate();
      await sleep(300);
      expect(ageMs()).toBeGreaterThan(30 * 60_000);
      const warnings = lock.warnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(lockPath());
      expect(warnings[0]).toMatch(/EPERM/);
      expect(warnings[0]).toMatch(/another backup or restore may not see this one as running/);
    });

    it("a normal filesystem is unaffected: utimes refreshes the lock, the file is never opened for rewriting, no warning", async () => {
      const open = vi.spyOn(fsp, "open");
      const lock = await acquire(dir, { heartbeatMs: 25 });
      backdate();
      await sleep(300);
      expect(ageMs()).toBeLessThan(10_000);
      expect(open.mock.calls.filter((c) => c[1] === "r+")).toEqual([]);
      expect(lock.warnings()).toEqual([]);
    });

    it("a lock that is gone (released by hand) is not a warning", async () => {
      refuseUtimes();
      const lock = await acquire(dir, { heartbeatMs: 25 });
      rmSync(lockPath());
      await sleep(150);
      expect(lock.warnings()).toEqual([]);
    });
  });

  it("a second acquire while the first is held fails with FullBackupAlreadyRunningError, and works again after release", async () => {
    const first = await acquire(dir);
    const second = acquireFullBackupLock(dir);
    await expect(second).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
    await expect(second).rejects.toMatchObject({ code: "ALREADY_RUNNING", pid: process.pid, hostname: HOST });
    expect(body().pid).toBe(process.pid); // the holder's lock is untouched
    await first.release();
    await (await acquire(dir)).release();
  });

  describe("same hostname: liveness is the pid", () => {
    it("another LIVE process with a fresh heartbeat is respected", async () => {
      plant({ pid: process.ppid, startedAt: new Date().toISOString(), hostname: HOST, token: "other" }, FULL_BACKUP_LOCK_STALE_MS - 30_000);
      await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      expect(body().token).toBe("other");
    });

    it("R12, the restart case: a LIVE pid whose heartbeat is old is reclaimed (the container restarted in place; that pid now belongs to the new server, not to a backup)", async () => {
      plant({ pid: process.ppid, startedAt: "2026-01-01T00:00:00.000Z", hostname: HOST, token: "crashed-run" }, FULL_BACKUP_LOCK_STALE_MS + 30_000);
      await acquire(dir);
      expect(body()).toMatchObject({ pid: process.pid, hostname: HOST });
      expect(body().token).not.toBe("crashed-run");
    });

    it("R12: this process's OWN held lock is live only while its heartbeat is fresh too", async () => {
      await acquire(dir, { heartbeatMs: 60_000 });
      await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      const old = new Date(Date.now() - FULL_BACKUP_LOCK_STALE_MS - 30_000);
      utimesSync(lockPath(), old, old);
      const second = await acquire(dir);
      expect(second.path).toBe(lockPath());
    });

    it("a DEAD pid is reclaimed at once, however fresh the heartbeat", async () => {
      plant({ pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", hostname: HOST, token: "stale" });
      const lock = await acquire(dir);
      expect(body()).toMatchObject({ pid: process.pid, hostname: HOST });
      await lock.release();
      expect(readdirSync(dir)).toEqual([]);
    });

    it("THIS pid, but not held by this process, is stale (a restarted container reuses its pid)", async () => {
      plant({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: HOST, token: "previous-run" });
      await acquire(dir);
      expect(body().token).not.toBe("previous-run");
    });
  });

  describe("different hostname: the pid means nothing, liveness is the heartbeat (mtime)", () => {
    it("a fresh heartbeat → already running, even though that pid is dead here", async () => {
      plant({ pid: deadPid(), startedAt: new Date().toISOString(), hostname: OTHER_HOST, token: "other" });
      const err = await acquireFullBackupLock(dir).catch((e) => e);
      expect(err).toBeInstanceOf(FullBackupAlreadyRunningError);
      expect(err.hostname).toBe(OTHER_HOST);
      expect(body().token).toBe("other");
    });

    it("a heartbeat just inside the threshold → already running; just outside → reclaimed", async () => {
      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "other" }, FULL_BACKUP_LOCK_STALE_MS - 30_000);
      await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);

      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "other" }, FULL_BACKUP_LOCK_STALE_MS + 30_000);
      await acquire(dir);
      expect(body()).toMatchObject({ pid: process.pid, hostname: HOST });
    });

    it("a stale heartbeat → reclaimed, even though pid 1 is alive here; the threshold is injectable", async () => {
      plant({ pid: process.ppid, startedAt: "x", hostname: OTHER_HOST, token: "other" }, 2_000);
      await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      await acquire(dir, { staleMs: 1_000 });
      expect(body().hostname).toBe(HOST);
    });

    it("the hostname is injectable: the same file is 'ours' or 'theirs' by that name alone", async () => {
      plant({ pid: deadPid(), startedAt: "x", hostname: "box-a", token: "t" });
      await expect(acquireFullBackupLock(dir, { hostname: "box-b" })).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      await acquire(dir, { hostname: "box-a" });
      expect(body().hostname).toBe("box-a");
    });
  });

  describe("a lock with no usable owner (unparseable, empty, or no hostname) is judged by its heartbeat alone", () => {
    it.each([
      ["garbage", "not json"],
      ["empty (a holder caught between create and write)", ""],
      ["legacy: pid but no hostname, dead pid", () => ({ pid: deadPid(), startedAt: "x", token: "t" })],
    ])("%s: fresh → already running; stale → reclaimed", async (_name, content) => {
      const value = typeof content === "function" ? content() : content;
      plant(value);
      await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      plant(value, FULL_BACKUP_LOCK_STALE_MS + 30_000);
      await acquire(dir);
      expect(body()).toMatchObject({ pid: process.pid, hostname: HOST });
    });
  });

  describe("heartbeat", () => {
    it("advances the lock file's mtime while the lock is held", async () => {
      await acquire(dir, { heartbeatMs: 20 });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath(), old, old);
      const deadline = Date.now() + 5_000;
      while (statSync(lockPath()).mtimeMs <= old.getTime() + 1000 && Date.now() < deadline) await sleep(10);
      expect(statSync(lockPath()).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
    });

    it("keeps another host out for as long as it beats: with a 300 ms threshold the lock is still live after 700 ms", async () => {
      await acquire(dir, { heartbeatMs: 25, hostname: "box-a" });
      await sleep(700);
      await expect(acquireFullBackupLock(dir, { hostname: "box-b", staleMs: 300 })).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
    });

    it("release stops the timer: no further heartbeat, and no timer left behind", async () => {
      const intervals = vi.spyOn(globalThis, "setInterval");
      const cleared = vi.spyOn(globalThis, "clearInterval");
      const utimes = vi.spyOn(fsp, "utimes");
      const lock = await acquire(dir, { heartbeatMs: 15 });
      const deadline = Date.now() + 5_000;
      while (utimes.mock.calls.length < 2 && Date.now() < deadline) await sleep(5);
      expect(utimes.mock.calls.length).toBeGreaterThanOrEqual(2);

      await lock.release();
      await sleep(30); // let a beat already in flight land
      const after = utimes.mock.calls.length;
      await sleep(150);
      expect(utimes.mock.calls.length).toBe(after);
      // ...because the lock's own interval was cleared, not merely because the file is gone.
      const timer = intervals.mock.results[0].value as NodeJS.Timeout;
      expect(cleared).toHaveBeenCalledWith(timer);
    });

    it("the timer is unref'd: a process that holds the lock and never releases it still exits on its own", async () => {
      // setInterval is observed, not replaced: the lock's own interval must have been unref'd.
      const spy = vi.spyOn(globalThis, "setInterval");
      await acquire(dir, { heartbeatMs: 10_000 });
      const timers = spy.mock.results.map((r) => r.value as NodeJS.Timeout);
      expect(timers).toHaveLength(1);
      expect(timers[0].hasRef()).toBe(false);
    });

    it("does not touch a lock that is no longer ours (reclaimed by someone else after a long stall)", async () => {
      await acquire(dir, { heartbeatMs: 15 });
      const old = new Date(Date.now() - 60_000);
      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "new-owner" }, 60_000);
      await sleep(120);
      expect(Math.abs(statSync(lockPath()).mtimeMs - old.getTime())).toBeLessThan(2_000);
    });
  });

  describe("reclaim with no leftover guard is exclusive", () => {
    it("25 contenders reclaiming the same stale lock: exactly one wins, the rest get 'already running'", async () => {
      for (let round = 0; round < 8; round++) {
        plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "stale" }, FULL_BACKUP_LOCK_STALE_MS * 2);
        const results = await Promise.allSettled(Array.from({ length: 25 }, () => acquireFullBackupLock(dir)));
        const won = results.filter((r): r is PromiseFulfilledResult<FullBackupLock> => r.status === "fulfilled");
        const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(won, `round ${round}`).toHaveLength(1);
        expect(lost.every((r) => r.reason instanceof FullBackupAlreadyRunningError), `round ${round}`).toBe(true);
        expect(body().pid).toBe(process.pid);
        await won[0].value.release();
        expect(readdirSync(dir), `round ${round}`).toEqual([]);
      }
    });

    it("25 contenders with no lock present: exactly one wins", async () => {
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => acquireFullBackupLock(dir)));
      const won = results.filter((r): r is PromiseFulfilledResult<FullBackupLock> => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      await won[0].value.release();
    });

    it("a reclaim already under way (fresh .reclaim guard) makes other contenders back off; a guard left by a crashed reclaimer is cleared once stale", async () => {
      const guard = `${lockPath()}.reclaim`;
      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "stale" }, FULL_BACKUP_LOCK_STALE_MS * 2);
      writeFileSync(guard, "");
      await expect(acquireFullBackupLock(dir)).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      expect(body().token).toBe("stale");

      const then = new Date(Date.now() - FULL_BACKUP_LOCK_STALE_MS * 2);
      utimesSync(guard, then, then);
      await acquire(dir);
      expect(body().pid).toBe(process.pid);
      expect(existsSync(guard)).toBe(false);
    });
  });

  describe("a stale reclaim guard (a reclaimer died holding it)", () => {
    const guardPath = () => `${lockPath()}.reclaim`;
    function plantStaleLockAndGuard(): void {
      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "stale" }, FULL_BACKUP_LOCK_STALE_MS * 2);
      writeFileSync(guardPath(), "dead-reclaimer");
      const then = new Date(Date.now() - FULL_BACKUP_LOCK_STALE_MS * 2);
      utimesSync(guardPath(), then, then);
    }

    // Covers the TWO-contender race only. With three contenders, or with B's claim landing
    // between A's guard check and A's rename, two can win or none can (full-lock.ts module
    // comment, "WHAT THIS DOES NOT GUARANTEE"); those orderings are accepted and not tested.
    it("FORCED interleaving, two contenders: both see the stale guard; A clears it and takes a fresh guard; B then acts on its old observation — B puts A's guard back, and A alone wins", async () => {
      plantStaleLockAndGuard();
      const gate = () => {
        let open!: () => void;
        const wait = new Promise<void>((r) => (open = r));
        return { wait, open };
      };
      // Each contender pauses (1) after seeing the stale guard, before acting on it, and (2) once it holds a guard of its own.
      const seen = { A: gate(), B: gate() };
      const go = { A: gate(), B: gate() };
      const holding = { A: gate(), B: gate() };
      const finish = { A: gate(), B: gate() };
      const contender = (name: "A" | "B") =>
        acquireFullBackupLock(dir, {
          hooks: {
            beforeStaleGuardClaim: async () => {
              seen[name].open();
              await go[name].wait;
            },
            afterGuardTaken: async () => {
              holding[name].open();
              await finish[name].wait;
            },
          },
        });

      const a = contender("A");
      const b = contender("B");
      a.catch(() => undefined);
      b.catch(() => undefined);
      await Promise.all([seen.A.wait, seen.B.wait]); // both have statted the OLD guard

      go.A.open();
      await holding.A.wait; // A cleared the stale guard and now holds a fresh one

      go.B.open(); // B acts on what it saw before A's guard existed
      await Promise.race([holding.B.wait, b.catch(() => undefined)]); // B either (wrongly) takes a guard, or backs off

      finish.A.open();
      finish.B.open();
      const results = await Promise.allSettled([a, b]);
      const won = results.filter((r): r is PromiseFulfilledResult<FullBackupLock> => r.status === "fulfilled");
      open.push(...won.map((w) => w.value));
      expect(won).toHaveLength(1);
      expect(results[0].status).toBe("fulfilled"); // A, whose guard it was
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(FullBackupAlreadyRunningError);
      expect(body().pid).toBe(process.pid);
      await won[0].value.release();
      expect(readdirSync(dir)).toEqual([]); // no lock, no guard, no claimed-guard leftovers
    });

    // What this run observes, not a proof: in-process contenders do not reach the orderings
    // that give two winners. A no-winner round that leaves an orphan guard would fail the
    // "within two rounds" assertion; that has not been seen, and is a documented limit, not a bug to chase here.
    it("25 contenders on a stale lock PLUS a stale guard: at most one winner per round observed, and the lock is taken within two rounds", async () => {
      for (let round = 0; round < 8; round++) {
        plantStaleLockAndGuard();
        let winners: FullBackupLock[] = [];
        for (let pass = 0; pass < 2 && winners.length === 0; pass++) {
          const results = await Promise.allSettled(Array.from({ length: 25 }, () => acquireFullBackupLock(dir)));
          winners = results.filter((r): r is PromiseFulfilledResult<FullBackupLock> => r.status === "fulfilled").map((r) => r.value);
          expect(winners.length, `round ${round} pass ${pass}`).toBeLessThanOrEqual(1);
          expect(
            results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof FullBackupAlreadyRunningError),
          ).toBe(true);
        }
        expect(winners, `round ${round}`).toHaveLength(1);
        await winners[0].release();
        expect(readdirSync(dir), `round ${round}`).toEqual([]);
      }
    });

    it("the guard holds its owner's token while a reclaim is in progress", async () => {
      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "stale" }, FULL_BACKUP_LOCK_STALE_MS * 2);
      let guardText = "";
      const lock = await acquire(dir, {
        hooks: {
          afterGuardTaken: async () => {
            guardText = readFileSync(guardPath(), "utf8");
          },
        },
      });
      expect(guardText).toMatch(/^[0-9a-f]{16}$/);
      expect(body().token).toBe(guardText);
      expect(existsSync(guardPath())).toBe(false);
      await lock.release();
    });

    it("a holder whose guard was taken away before it could finish backs off instead of replacing the lock", async () => {
      plant({ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "stale" }, FULL_BACKUP_LOCK_STALE_MS * 2);
      const attempt = acquireFullBackupLock(dir, {
        hooks: {
          afterGuardTaken: async () => {
            writeFileSync(guardPath(), "someone-else"); // as if another contender now holds the guard
          },
        },
      });
      await expect(attempt).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
      expect(body().token).toBe("stale"); // not replaced
      expect(readFileSync(guardPath(), "utf8")).toBe("someone-else"); // and their guard is left alone
    });
  });

  it("release is idempotent and never removes a lock that is not ours", async () => {
    const lock = await acquire(dir);
    await lock.release();
    await lock.release();
    const other = await acquire(dir);
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

describe("fullBackupLockStatus (read-only: the liveness rule without taking the lock)", () => {
  /** Everything in the folder: name, content and mtime. A status call must leave all of it as it was. */
  const snapshot = () => readdirSync(dir).sort().map((n) => [n, readFileSync(path.join(dir, n), "utf8"), statSync(path.join(dir, n)).mtimeMs]);
  const HELD = (pid: number, hostname: string, startedAt: string) => ({ held: true, pid, hostname, startedAt });

  it("no lock file, or no backup folder at all: free", async () => {
    expect(await fullBackupLockStatus(dir)).toEqual({ held: false });
    expect(readdirSync(dir)).toEqual([]);
    expect(await fullBackupLockStatus(path.join(dir, "no-such-folder"))).toEqual({ held: false });
  });

  describe("same hostname: the pid must be alive AND the heartbeat fresh", () => {
    it("a live pid with a fresh heartbeat: held, and the holder is named", async () => {
      plant({ pid: process.ppid, startedAt: "2026-10-03T03:15:00.000Z", hostname: HOST, token: "other" }, FULL_BACKUP_LOCK_STALE_MS - 30_000);
      const before = snapshot();
      expect(await fullBackupLockStatus(dir)).toEqual(HELD(process.ppid, HOST, "2026-10-03T03:15:00.000Z"));
      expect(snapshot()).toEqual(before);
    });

    it("a live pid with a stale heartbeat: free (the lock is left where it is)", async () => {
      plant({ pid: process.ppid, startedAt: "x", hostname: HOST, token: "crashed-run" }, FULL_BACKUP_LOCK_STALE_MS + 30_000);
      const before = snapshot();
      expect(await fullBackupLockStatus(dir)).toEqual({ held: false });
      expect(snapshot()).toEqual(before);
    });

    it("a dead pid, however fresh the heartbeat: free", async () => {
      plant({ pid: deadPid(), startedAt: "x", hostname: HOST, token: "stale" });
      expect(await fullBackupLockStatus(dir)).toEqual({ held: false });
      expect(body().token).toBe("stale");
    });

    it("a lock this process really holds: held; a lock that only carries this pid: free", async () => {
      const lock = await acquire(dir);
      expect(await fullBackupLockStatus(dir)).toMatchObject({ held: true, pid: process.pid, hostname: HOST });
      await lock.release();
      plant({ pid: process.pid, startedAt: "x", hostname: HOST, token: "previous-run" });
      expect(await fullBackupLockStatus(dir)).toEqual({ held: false });
    });
  });

  describe("another hostname: only the heartbeat decides", () => {
    it("fresh: held, even though that pid is dead here", async () => {
      plant({ pid: deadPid(), startedAt: "2026-10-03T03:15:00.000Z", hostname: OTHER_HOST, token: "other" }, FULL_BACKUP_LOCK_STALE_MS - 30_000);
      expect(await fullBackupLockStatus(dir)).toMatchObject({ held: true, hostname: OTHER_HOST, startedAt: "2026-10-03T03:15:00.000Z" });
    });

    it("stale: free, even though the pid is alive here", async () => {
      plant({ pid: process.ppid, startedAt: "x", hostname: OTHER_HOST, token: "other" }, FULL_BACKUP_LOCK_STALE_MS + 30_000);
      expect(await fullBackupLockStatus(dir)).toEqual({ held: false });
    });

    it("the hostname and the threshold are injectable, as for the acquire", async () => {
      plant({ pid: deadPid(), startedAt: "x", hostname: "box-a", token: "t" }, 2_000);
      expect(await fullBackupLockStatus(dir, { hostname: "box-b" })).toMatchObject({ held: true, hostname: "box-a" });
      expect(await fullBackupLockStatus(dir, { hostname: "box-b", staleMs: 1_000 })).toEqual({ held: false });
      expect(await fullBackupLockStatus(dir, { hostname: "box-a" })).toEqual({ held: false }); // ours, and that pid is dead
    });
  });

  it.each([
    ["garbage", "not json"],
    ["empty (a holder caught between create and write)", ""],
    ["no hostname", JSON.stringify({ pid: 1, startedAt: "x", token: "t" })],
  ])("no usable owner (%s): fresh → held by an unknown holder; stale → free", async (_name, content) => {
    plant(content);
    const fresh = await fullBackupLockStatus(dir);
    expect(fresh.held).toBe(true);
    if (fresh.held) expect(fresh.hostname).toBe("unknown");
    plant(content, FULL_BACKUP_LOCK_STALE_MS + 30_000);
    expect(await fullBackupLockStatus(dir)).toEqual({ held: false });
  });

  it("agrees with the acquire on every one of these files: held ⇔ the acquire answers 'already running'", async () => {
    const cases: Array<[unknown, number]> = [
      [{ pid: process.ppid, startedAt: "x", hostname: HOST, token: "a" }, 0],
      [{ pid: process.ppid, startedAt: "x", hostname: HOST, token: "a" }, FULL_BACKUP_LOCK_STALE_MS + 30_000],
      [{ pid: deadPid(), startedAt: "x", hostname: HOST, token: "a" }, 0],
      [{ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "a" }, 0],
      [{ pid: 1, startedAt: "x", hostname: OTHER_HOST, token: "a" }, FULL_BACKUP_LOCK_STALE_MS + 30_000],
      ["not json", 0],
      ["not json", FULL_BACKUP_LOCK_STALE_MS + 30_000],
    ];
    for (const [content, age] of cases) {
      plant(content, age);
      const status = await fullBackupLockStatus(dir);
      const taken = await acquireFullBackupLock(dir).then(
        async (lock) => {
          await lock.release();
          return true;
        },
        (e) => {
          if (e instanceof FullBackupAlreadyRunningError) return false;
          throw e;
        },
      );
      expect(status.held, JSON.stringify([content, age])).toBe(!taken);
    }
  });

  it("an unreadable lock is an error, not 'free'", async () => {
    await fsp.mkdir(lockPath()); // a folder where the lock file should be: the read fails with EISDIR
    await expect(fullBackupLockStatus(dir)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
