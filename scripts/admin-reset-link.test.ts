import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

/**
 * scripts/admin-reset-link.mjs against REAL SQLite, run exactly as the container runs it:
 * `node scripts/admin-reset-link.mjs <username> [--promote]`. The script is plain JS and
 * reimplements generateToken/hashToken from src/lib/auth/tokens.ts with node:crypto instead of
 * importing the TS module — this proves the reimplementation is byte-for-byte equivalent by
 * hashing the printed token with the real TS hashToken and comparing it to the stored row.
 *
 * A throw-away database in a temp dir, migrated with `prisma migrate deploy`, deleted afterwards;
 * the dev database is never touched. Same temp-DB approach as src/lib/auth/redeem.real-db.test.ts.
 */
const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
const dir = `${base}/bv-admin-reset-link-${process.pid}-${Date.now()}`;
const file = `${dir}/t.db`;
const DATABASE_URL = `file:${file}?connection_limit=1`;
const PUBLIC_URL = "https://vault.example.com";

import type { PrismaClient } from "@prisma/client";
import { hashToken as realHashToken } from "@/lib/auth/tokens";

let prisma: PrismaClient;

function runScript(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("node", ["scripts/admin-reset-link.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL, PUBLIC_URL, ...env },
  });
}

describe("scripts/admin-reset-link.mjs against real SQLite", () => {
  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL },
      stdio: "pipe",
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: SqliteClient } = require(".prisma/client-sqlite");
    prisma = new SqliteClient({ datasourceUrl: DATABASE_URL }) as PrismaClient;

    await prisma.user.create({
      data: { username: "jeff", displayName: "Jeff", passwordHash: "x", role: "USER" },
    });
    await prisma.user.create({
      data: {
        username: "grounded",
        displayName: "Grounded",
        passwordHash: "x",
        role: "USER",
        disabledAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("happy path: prints the link, exits 0, and creates an unused RESET row whose hash matches the printed token", async () => {
    const before = new Date();
    const result = runScript(["jeff"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(
      /^Reset link for jeff \(valid 24 hours\): https:\/\/vault\.example\.com\/reset\/[A-Za-z0-9_-]{43}$/,
    );

    const token = result.stdout.trim().split("/reset/")[1];
    const row = await prisma.authToken.findUnique({ where: { tokenHash: realHashToken(token) } });
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("RESET");
    expect(row?.usedAt).toBeNull();
    expect(row?.createdById).toBeNull();
    const user = await prisma.user.findUnique({ where: { username: "jeff" } });
    expect(row?.userId).toBe(user?.id);
    expect(row?.expiresAt).not.toBeNull();
    const ttlMs = (row!.expiresAt as Date).getTime() - before.getTime();
    expect(ttlMs).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(24.1 * 60 * 60 * 1000);

    // One RESET_LINK_ISSUED row, on the same transaction as the token, naming the
    // recovery CLI as actor — never the token or the printed URL.
    const events = await prisma.auditEvent.findMany({ where: { entityId: user?.id, action: "RESET_LINK_ISSUED" } });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      actorId: null,
      actorName: "system (recovery CLI)",
      actorIp: null,
      action: "RESET_LINK_ISSUED",
      entityType: "User",
      entityId: user?.id,
      entityLabel: "Jeff (@jeff)",
    });
    expect(event.changes ?? "").not.toContain(token);
    expect(event.changes ?? "").not.toContain("reset/");
  });

  it("username normalisation: trims and lowercases like normaliseUsername, matching the stored record", () => {
    const result = runScript([" Jeff "]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Reset link for jeff (valid 24 hours):");
  });

  it("--promote sets role ADMIN and clears disabledAt atomically with creating the link", async () => {
    const result = runScript(["grounded", "--promote"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Reset link for grounded (valid 24 hours):");

    const token = result.stdout.trim().split("/reset/")[1];
    const row = await prisma.authToken.findUnique({ where: { tokenHash: realHashToken(token) } });
    expect(row).not.toBeNull();
    expect(row?.usedAt).toBeNull();

    const user = await prisma.user.findUnique({ where: { username: "grounded" } });
    expect(user?.role).toBe("ADMIN");
    expect(user?.disabledAt).toBeNull();

    const events = await prisma.auditEvent.findMany({ where: { entityId: user?.id, action: "RESET_LINK_ISSUED" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorName: "system (recovery CLI)", entityLabel: "Grounded (@grounded)" });
  });

  it("unknown user: exit 1 with a clear message, no DB writes (including no audit event)", async () => {
    const beforeTokens = await prisma.authToken.count();
    const beforeEvents = await prisma.auditEvent.count();
    const result = runScript(["nobody-here"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No user named "nobody-here"');
    expect(result.stdout).toBe("");
    expect(await prisma.authToken.count()).toBe(beforeTokens);
    expect(await prisma.auditEvent.count()).toBe(beforeEvents);
  });

  it("no args: exit 2 with usage", () => {
    const result = runScript([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: node scripts/admin-reset-link.mjs <username> [--promote]");
  });

  it("PUBLIC_URL unset: exit 1 with a clear, actionable message", () => {
    const result = runScript(["jeff"], { PUBLIC_URL: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BLACKVAULT_PUBLIC_URL is not set");
  });
});
