import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * Single-use tokens against REAL SQLite (Review Focus #2 and #4). The mocked route tests
 * simulate rollback; this proves it: two concurrent redemptions of one invite create exactly
 * one account, and a duplicate username rolls the transaction back so the invite stays unused.
 *
 * A throw-away database in a temp dir, migrated with `prisma migrate deploy`, deleted
 * afterwards; the dev database is never touched. The env is set in vi.hoisted so the real
 * @/lib/prisma singleton binds to the temp file — with `connection_limit=1`, exactly as
 * docker-compose.yml ships SQLite. A second client with a larger pool covers the case where
 * two connections really do race at the SQLite level.
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-redeem-real-db-${process.pid}-${Date.now()}`;
  const file = `${dir}/t.db`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${file}?connection_limit=1`;
  return { dir, file };
});

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { consumeToken, createInvite, hashToken } from "@/lib/auth/tokens";
import { POST as redeem } from "@/app/api/auth/redeem/route";

const PW = "correct horse battery";
let pooled: PrismaClient;
let admin: { id: string };

function redeemReq(body: unknown) {
  return new NextRequest("http://localhost/api/auth/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function usedAt(raw: string) {
  return (await prisma.authToken.findUnique({ where: { tokenHash: hashToken(raw) } }))?.usedAt ?? null;
}

describe("token redemption against real SQLite", () => {
  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${ctx.file}` },
      stdio: "pipe",
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: SqliteClient } = require(".prisma/client-sqlite");
    pooled = new SqliteClient({ datasourceUrl: `file:${ctx.file}?connection_limit=4` }) as PrismaClient;
    admin = await prisma.user.create({
      data: { username: "admin", displayName: "Admin", passwordHash: "x", role: "ADMIN" },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await pooled?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("two concurrent consumeToken transactions (shipped pool of 1): exactly one wins", async () => {
    const { token } = await createInvite({ role: "USER", createdById: admin.id });
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => consumeToken(token, "INVITE", tx)),
      prisma.$transaction((tx) => consumeToken(token, "INVITE", tx)),
    ]);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : r.reason));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(values.filter((v) => v !== null)).toHaveLength(1);
    expect(await usedAt(token)).toBeInstanceOf(Date);
  });

  it("two concurrent consumeToken transactions on a pooled client (4 connections): exactly one wins", async () => {
    const { token } = await createInvite({ role: "USER", createdById: admin.id });
    const results = await Promise.allSettled([
      pooled.$transaction((tx) => consumeToken(token, "INVITE", tx)),
      pooled.$transaction((tx) => consumeToken(token, "INVITE", tx)),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(winners).toHaveLength(1);
    expect(await usedAt(token)).toBeInstanceOf(Date);
  });

  it("two concurrent redeem requests for one invite: one 200, one 404, one account", async () => {
    const { token } = await createInvite({ role: "USER", createdById: admin.id });
    const [a, b] = await Promise.all([
      redeem(redeemReq({ token, username: "tab-a", displayName: "Tab A", password: PW })),
      redeem(redeemReq({ token, username: "tab-b", displayName: "Tab B", password: PW })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    const loser = a.status === 404 ? a : b;
    expect(await loser.json()).toEqual({ error: "Link expired or already used" });
    expect(await prisma.user.count({ where: { username: { in: ["tab-a", "tab-b"] } } })).toBe(1);
  });

  it("duplicate username (case/space variant) → 409 and the invite is NOT consumed; a retry succeeds", async () => {
    await prisma.user.create({ data: { username: "jeff", displayName: "Jeff", passwordHash: "x", role: "USER" } });
    const { token } = await createInvite({ role: "USER", createdById: admin.id });

    const dup = await redeem(redeemReq({ token, username: " Jeff ", displayName: "Other", password: PW }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "Username taken" });
    expect(await usedAt(token)).toBeNull();

    const retry = await redeem(redeemReq({ token, username: "jeff-2", displayName: "Other", password: PW }));
    expect(retry.status).toBe(200);
    expect(await usedAt(token)).toBeInstanceOf(Date);
    expect((await prisma.user.findUnique({ where: { username: "jeff-2" } }))?.role).toBe("USER");
  });
});
