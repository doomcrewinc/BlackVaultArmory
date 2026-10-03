import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * Task 5 fix round 1: the Settings button's POST route driving the REAL
 * engine (runFullBackup) against a throw-away SQLite file (connection_limit=1),
 * a scratch uploads root and a scratch backup folder. The repo's uploads/,
 * data/ and prisma/prisma/dev.db are never touched. The route/job wiring
 * (progress mapping, result mapping, audit actor) is what the mocked tests in
 * route.test.ts cannot check.
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-full-route-${process.pid}-${Date.now()}`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  process.env.IMAGE_UPLOAD_DIR = `${dir}/uploads`;
  return { dir, backups: `${dir}/backups`, uploads: `${dir}/uploads` };
});

const auth = vi.hoisted(() => ({ validateSession: vi.fn() }));
const ADMIN = { sessionId: "s1", user: { id: "admin-user-1", username: "admin", displayName: "Alice Admin", role: "ADMIN" } };
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: auth.validateSession }));

// The backup folder is a constant in full-lock.ts; point it at the scratch folder.
vi.mock("@/lib/backup/full-lock", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/full-lock")>()),
  DEFAULT_FULL_BACKUP_DIR: ctx.backups,
}));

import { createRawPrismaClient, prisma } from "@/lib/prisma";
import { writeEncryptedFile } from "@/lib/files/storage";
import { POST } from "./route";
import { GET } from "./status/route";
import { resetFullBackupJobForTests, type FullBackupStatus } from "@/lib/backup/full-job";

const PASS = "correct horse battery staple";
const NAME = /^blackvault-full-\d{8}-\d{6}\.bvb$/;

function post() {
  return new NextRequest("http://localhost/api/backup/full", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase: PASS }),
  });
}

/** Polls the status endpoint until the job leaves "running"; returns every body seen. */
async function pollToEnd(): Promise<{ seen: FullBackupStatus[]; texts: string[] }> {
  const seen: FullBackupStatus[] = [];
  const texts: string[] = [];
  const deadline = Date.now() + 60_000;
  for (;;) {
    const text = await (await GET()).text();
    texts.push(text);
    const s = JSON.parse(text) as FullBackupStatus;
    seen.push(s);
    if (s.state !== "running") return { seen, texts };
    if (Date.now() > deadline) throw new Error("job did not finish in 60 s (deadlock?)");
    await new Promise((r) => setTimeout(r, 2));
  }
}

let raw: ReturnType<typeof createRawPrismaClient>;

describe("POST /api/backup/full with the real engine", () => {
  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${ctx.dir}/t.db` },
      stdio: "pipe",
      timeout: 90_000,
    });
    raw = createRawPrismaClient();
    await raw.user.create({ data: { id: "admin-user-1", username: "admin", displayName: "Alice Admin", passwordHash: "x", role: "ADMIN" } });
    await prisma.firearm.create({
      data: {
        name: "Route test pistol", manufacturer: "Glock", model: "19", caliber: "9mm",
        serialNumber: "SER-ROUTE-1", type: "PISTOL", acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await raw?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    auth.validateSession.mockResolvedValue(ADMIN);
    resetFullBackupJobForTests();
    await raw.auditEvent.deleteMany();
    rmSync(ctx.backups, { recursive: true, force: true });
    rmSync(ctx.uploads, { recursive: true, force: true });
    mkdirSync(ctx.backups, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(ctx.uploads, "images"), { recursive: true });
    mkdirSync(path.join(ctx.uploads, "documents"), { recursive: true });
    await writeEncryptedFile(path.join(ctx.uploads, "images", "a.jpg"), Buffer.alloc(2 * 1024 * 1024 + 7, 0x41));
    await writeEncryptedFile(path.join(ctx.uploads, "documents", "b.pdf"), Buffer.from("%PDF-1.4 route test"));
  });

  it("202, then a succeeded status with the real file, count, size and phase progress; archive on disk; audit names the admin", async () => {
    const res = await POST(post());
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    const { seen, texts } = await pollToEnd();
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ jobId, state: "succeeded", files: 2, bytes: 2 * 1024 * 1024 + 7 + "%PDF-1.4 route test".length, skipped: [], warnings: [] });
    expect(last.file).toMatch(NAME);
    expect(readdirSync(ctx.backups)).toEqual([last.file]);

    // Phase progress came through the real onProgress mapping.
    const phases = new Set(seen.map((s) => s.phase).filter(Boolean));
    expect(phases.size).toBeGreaterThan(0);
    for (const s of seen.filter((x) => x.phase === "writing")) expect(s.filesTotal).toBe(2);
    expect(last.phase).toBe("verifying");
    expect(last).toMatchObject({ filesDone: 2, filesTotal: 2 });

    // The audit entry is attributed to the requesting admin (the actor wiring).
    const rows = await raw.auditEvent.findMany({ where: { action: "BACKUP_CREATED" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe("admin-user-1");
    expect(rows[0].actorName).toBe("Alice Admin");
    expect(rows[0].entityLabel).toBe(last.file);

    for (const t of [...texts, JSON.stringify({ jobId }), rows[0].changes ?? ""]) expect(t).not.toContain(PASS);
  }, 90_000);

  it("a backup folder that is not a folder: failed job whose error names the folder; the next POST is accepted", async () => {
    rmSync(ctx.backups, { recursive: true, force: true });
    writeFileSync(ctx.backups, "not a folder");

    expect((await POST(post())).status).toBe(202);
    const { seen, texts } = await pollToEnd();
    const last = seen.at(-1)!;
    expect(last.state).toBe("failed");
    expect(last.error).toContain(ctx.backups);
    for (const t of texts) expect(t).not.toContain(PASS);

    rmSync(ctx.backups, { force: true });
    mkdirSync(ctx.backups, { mode: 0o700 });
    expect((await POST(post())).status).toBe(202);
    expect((await pollToEnd()).seen.at(-1)!.state).toBe("succeeded");
    expect(existsSync(ctx.backups)).toBe(true);
  }, 90_000);
});
