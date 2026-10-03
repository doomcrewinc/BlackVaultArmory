import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";

const auth = vi.hoisted(() => ({ validateSession: vi.fn() }));
const ADMIN_SESSION = { sessionId: "s1", user: { id: "u1", username: "admin", displayName: "Admin", role: "ADMIN" } };
const USER_SESSION = { sessionId: "s2", user: { id: "u2", username: "jeff", displayName: "Jeff", role: "USER" } };
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: auth.validateSession }));

// A scratch backup folder stands in for /app/backups (never the repo's data/ or uploads/).
const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path") as typeof import("path");
  return { dir: mkdtempSync(join(tmpdir(), "bv-fullbackup-route-")) };
});
vi.mock("@/lib/backup/full-lock", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/full-lock")>()),
  DEFAULT_FULL_BACKUP_DIR: scratch.dir,
}));

const engine = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/backup/full-backup", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/full-backup")>()),
  runFullBackup: engine.run,
}));

import { POST } from "./route";
import { GET } from "./status/route";
import { acquireFullBackupLock } from "@/lib/backup/full-lock";
import { resetFullBackupJobForTests } from "@/lib/backup/full-job";

const PASSPHRASE = "correct horse battery staple";

function post(body: unknown = { passphrase: PASSPHRASE }, raw?: string) {
  return new NextRequest("http://localhost/api/backup/full", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

/** A run the test controls: resolves/rejects when told, can emit progress. */
function controlledRun() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  let onProgress: ((p: unknown) => void) | undefined;
  const started = new Promise<void>((go) => {
    engine.run.mockImplementationOnce((opts: { onProgress?: (p: unknown) => void }) => {
      onProgress = opts.onProgress;
      go();
      return new Promise((res, rej) => { resolve = res; reject = rej; });
    });
  });
  return { started, resolve: (v: unknown) => resolve(v), reject: (e: unknown) => reject(e), progress: (p: unknown) => onProgress?.(p) };
}

const RESULT = { file: "blackvault-full-20261002-180405.bvb", path: "/x/y", files: 3, bytes: 1234, archiveBytes: 2000, skipped: [], warnings: [] };

async function status() {
  const res = await GET();
  const text = await res.text();
  return { res, body: JSON.parse(text), text };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  auth.validateSession.mockResolvedValue(ADMIN_SESSION);
  engine.run.mockReset();
  resetFullBackupJobForTests();
});
afterEach(() => resetFullBackupJobForTests());
afterAll(() => fs.rmSync(scratch.dir, { recursive: true, force: true }));

describe("authorisation", () => {
  it("non-admin gets 403 on POST and GET, and no job starts", async () => {
    auth.validateSession.mockResolvedValue(USER_SESSION);
    expect((await POST(post())).status).toBe(403);
    expect((await GET()).status).toBe(403);
    expect(engine.run).not.toHaveBeenCalled();
  });
  it("signed-out gets 401", async () => {
    auth.validateSession.mockResolvedValue(null);
    expect((await POST(post())).status).toBe(401);
    expect((await GET()).status).toBe(401);
  });
});

describe("POST /api/backup/full validation", () => {
  it.each([
    ["missing passphrase", {}],
    ["non-string passphrase", { passphrase: 123456789012 }],
    ["short passphrase", { passphrase: "short" }],
    ["11 code points", { passphrase: "12345678901" }],
  ])("%s -> 400, no job", async (_n, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(engine.run).not.toHaveBeenCalled();
    expect((await status()).body.state).toBe("idle");
  });
  it("invalid JSON -> 400", async () => {
    expect((await POST(post(undefined, "{nope"))).status).toBe(400);
  });
  it("counts code points after NFC, not UTF-16 units", async () => {
    // 12 astral code points = 24 UTF-16 units: accepted. 6 of them is 12 units: refused.
    const run = controlledRun();
    expect((await POST(post({ passphrase: "😀".repeat(12) }))).status).toBe(202);
    run.resolve(RESULT);
    await settle();
    expect((await POST(post({ passphrase: "😀".repeat(6) }))).status).toBe(400);
  });
});

describe("job lifecycle", () => {
  it("returns 202 + jobId immediately and runs to completion", async () => {
    const run = controlledRun();
    const res = await POST(post());
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(typeof jobId).toBe("string");
    await run.started;
    const opts = engine.run.mock.calls[0][0];
    expect(opts.passphrase).toBe(PASSPHRASE);
    expect(opts.actor).toEqual({ actorId: "u1", actorName: "Admin" });

    run.progress({ phase: "writing", filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30 });
    let s = (await status()).body;
    expect(s).toMatchObject({ jobId, state: "running", phase: "writing", filesDone: 1, filesTotal: 3, bytesDone: 10, bytesTotal: 30 });

    run.resolve(RESULT);
    await settle();
    s = (await status()).body;
    expect(s).toMatchObject({ jobId, state: "succeeded", file: RESULT.file, files: 3, bytes: 1234, skipped: [], warnings: [] });
    expect(s.error).toBeUndefined();
    // The last result stays readable until the next job starts.
    expect((await status()).body.state).toBe("succeeded");
  });

  it("a second POST while running -> 409", async () => {
    const run = controlledRun();
    expect((await POST(post())).status).toBe(202);
    await run.started;
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect(engine.run).toHaveBeenCalledTimes(1);
    run.resolve(RESULT);
    await settle();
  });

  it("two simultaneous POSTs start exactly one job", async () => {
    const run = controlledRun();
    const [a, b] = await Promise.all([POST(post()), POST(post())]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await run.started;
    expect(engine.run).toHaveBeenCalledTimes(1);
    run.resolve(RESULT);
    await settle();
  });

  it("the engine's lock held elsewhere -> 409, and the status is not left 'running'", async () => {
    const held = await acquireFullBackupLock(scratch.dir);
    try {
      const res = await POST(post());
      expect(res.status).toBe(409);
      expect(engine.run).not.toHaveBeenCalled();
      expect((await status()).body.state).toBe("idle");
    } finally {
      await held.release();
    }
  });

  it("the engine itself reporting the lock error -> job fails with that error; next POST accepted", async () => {
    const { FullBackupAlreadyRunningError } = await import("@/lib/backup/full-lock");
    const first = controlledRun();
    expect((await POST(post())).status).toBe(202);
    await first.started;
    first.reject(new FullBackupAlreadyRunningError({ pid: 9, startedAt: "t", hostname: "h" }));
    await settle();
    expect((await status()).body).toMatchObject({ state: "failed" });
    const second = controlledRun();
    expect((await POST(post())).status).toBe(202);
    await second.started;
    second.resolve(RESULT);
    await settle();
  });

  it("a failed job surfaces error naming the folder, and the next POST is accepted", async () => {
    const run = controlledRun();
    const { jobId } = await (await POST(post())).json();
    await run.started;
    run.reject(new Error(`The backup folder ${scratch.dir} is not writable (EACCES).`));
    await settle();
    const s = (await status()).body;
    expect(s).toMatchObject({ jobId, state: "failed" });
    expect(s.error).toContain(scratch.dir);
    expect(s.file).toBeUndefined();

    const next = controlledRun();
    const res = await POST(post());
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).not.toBe(jobId);
    await next.started;
    expect((await status()).body.state).toBe("running");
    next.resolve(RESULT);
    await settle();
  });

  it("an engine that throws synchronously -> job failed (not stuck running); the next POST is accepted", async () => {
    engine.run.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });
    const res = await POST(post());
    expect(res.status).toBe(202);
    await settle();
    expect((await status()).body).toMatchObject({ state: "failed", error: "sync boom" });

    const next = controlledRun();
    expect((await POST(post())).status).toBe(202);
    await next.started;
    next.resolve(RESULT);
    await settle();
    expect((await status()).body.state).toBe("succeeded");
  });

  it("a rejection from the detached run does not become an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const run = controlledRun();
      await POST(post());
      await run.started;
      run.reject(new Error("boom"));
      await settle();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("reports skipped files and warnings in the result", async () => {
    const run = controlledRun();
    await POST(post());
    await run.started;
    const skipped = [
      { path: "files/images/a.jpg", reason: "vanished", kind: "vanished" },
      { path: "files/documents/b.pdf", reason: "unreadable: EACCES", kind: "unreadable" },
    ];
    run.resolve({ ...RESULT, skipped, warnings: ["folder fsync failed"] });
    await settle();
    expect((await status()).body).toMatchObject({ state: "succeeded", skipped, warnings: ["folder fsync failed"] });
  });
});

describe("the passphrase never leaks", () => {
  it("is absent from every status body (running, succeeded, failed) and from POST responses", async () => {
    const bodies: string[] = [];
    const run = controlledRun();
    const res = await POST(post());
    bodies.push(await res.text());
    await run.started;
    run.progress({ phase: "writing", filesDone: 0, filesTotal: 1, bytesDone: 0, bytesTotal: 1 });
    bodies.push((await status()).text);
    run.resolve(RESULT);
    await settle();
    bodies.push((await status()).text);

    const failing = controlledRun();
    await POST(post());
    await failing.started;
    failing.reject(new Error("disk full"));
    await settle();
    bodies.push((await status()).text);

    const bad = await POST(post({ passphrase: "tiny" }));
    bodies.push(await bad.text());
    for (const b of bodies) expect(b).not.toContain(PASSPHRASE);
  });

  it("the job state holds no reference to it after the run ends", async () => {
    const run = controlledRun();
    await POST(post());
    await run.started;
    run.resolve(RESULT);
    await settle();
    const g = globalThis as unknown as { __blackvaultFullBackupJob?: unknown };
    expect(JSON.stringify(g.__blackvaultFullBackupJob)).not.toContain(PASSPHRASE);
  });
});

describe("idle", () => {
  it("GET before any job -> state idle with zero counters", async () => {
    expect((await status()).body).toMatchObject({ state: "idle", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 });
  });
});
