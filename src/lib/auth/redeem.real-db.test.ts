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
import { changeRoleOrStatus } from "@/lib/auth/admins";
import InvitePage from "@/app/invite/[token]/page";
import { LinkExpired } from "@/components/auth/LinkExpired";

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

  it("a redeem that rolls back (duplicate username) writes no INVITE_REDEEMED row; a retry does", async () => {
    await prisma.user.create({ data: { username: "rollback-collide", displayName: "X", passwordHash: "x", role: "USER" } });
    const { token } = await createInvite({ role: "USER", createdById: admin.id });
    const before = await prisma.auditEvent.count();

    const dup = await redeem(redeemReq({ token, username: "rollback-collide", displayName: "Other", password: PW }));
    expect(dup.status).toBe(409);
    expect(await usedAt(token)).toBeNull();
    // The INVITE_REDEEMED write happens inside the same transaction as tx.user.create
    // (redeem.ts:57), which P2002 rolled back — proves it rolled back with everything else.
    // Count (not findFirst) because earlier tests in this suite already wrote their own
    // INVITE_REDEEMED rows for other usernames.
    expect(await prisma.auditEvent.count()).toBe(before);
    expect(
      await prisma.auditEvent.findFirst({ where: { action: "INVITE_REDEEMED", actorName: { contains: "rollback-collide" } } }),
    ).toBeNull();

    // Not vacuous: a successful redemption of the same invite DOES write one row.
    const retry = await redeem(redeemReq({ token, username: "rollback-collide-2", displayName: "Other", password: PW }));
    expect(retry.status).toBe(200);
    expect(await prisma.auditEvent.count()).toBe(before + 1);
    const event = await prisma.auditEvent.findFirst({
      where: { action: "INVITE_REDEEMED", actorName: { contains: "rollback-collide" } },
    });
    expect(event).toMatchObject({ action: "INVITE_REDEEMED", entityType: "User", actorName: "Other (@rollback-collide-2)" });
  });
  describe("an invite dies with its issuer's admin rights (ruling A13)", () => {
    async function issuer(username: string) {
      return prisma.user.create({ data: { username, displayName: username, passwordHash: "x", role: "ADMIN" } });
    }
    async function invitePageIsExpired(token: string) {
      const jsx = (await InvitePage({ params: Promise.resolve({ token }) })) as { type: unknown };
      return jsx.type === LinkExpired;
    }

    it("active issuer → the invite page shows the form and redemption works", async () => {
      const jeff = await issuer("issuer-active");
      const { token } = await createInvite({ role: "ADMIN", createdById: jeff.id });
      expect(await invitePageIsExpired(token)).toBe(false);
      const res = await redeem(redeemReq({ token, username: "via-active", displayName: "V", password: PW }));
      expect(res.status).toBe(200);
      expect((await prisma.user.findUnique({ where: { username: "via-active" } }))?.role).toBe("ADMIN");
    });

    it.each([
      ["disabled", { disabledAt: new Date() }],
      ["demoted to USER", { role: "USER" }],
    ])("issuer %s (row changed directly) → page expired, redeem 404, no account, invite unused", async (label, data) => {
      const jeff = await issuer(`issuer-${label.split(" ")[0]}`);
      const { token } = await createInvite({ role: "ADMIN", createdById: jeff.id });
      await prisma.user.update({ where: { id: jeff.id }, data });

      expect(await invitePageIsExpired(token)).toBe(true);
      const username = `back-${label.split(" ")[0]}`;
      const res = await redeem(redeemReq({ token, username, displayName: "Jeff again", password: PW }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Link expired or already used" });
      expect(await prisma.user.findUnique({ where: { username } })).toBeNull();
      expect(await usedAt(token)).toBeNull();
    });

    it("consumeToken itself refuses an inactive issuer's invite inside the transaction (issuer disabled after the peek)", async () => {
      const jeff = await issuer("issuer-consume");
      const { token } = await createInvite({ role: "ADMIN", createdById: jeff.id });
      await prisma.user.update({ where: { id: jeff.id }, data: { disabledAt: new Date() } });
      expect(await prisma.$transaction((tx) => consumeToken(token, "INVITE", tx))).toBeNull();
      expect(await usedAt(token)).toBeNull();
      await prisma.user.update({ where: { id: jeff.id }, data: { disabledAt: null } });
      expect(await prisma.$transaction((tx) => consumeToken(token, "INVITE", tx))).toEqual({ role: "ADMIN", userId: null });
    });

    it.each([
      ["disabled", { disabled: true }],
      ["demoted", { role: "USER" as const }],
    ])("issuer %s through changeRoleOrStatus → their unused links are burned and the invite fails", async (label, change) => {
      const jeff = await issuer(`issuer-crs-${label}`);
      const { token } = await createInvite({ role: "ADMIN", createdById: jeff.id });
      const other = await createInvite({ role: "USER", createdById: admin.id });
      expect(await changeRoleOrStatus(jeff.id, change, admin.id)).toEqual({ ok: true });

      expect(await usedAt(token)).toBeInstanceOf(Date);
      expect(await usedAt(other.token)).toBeNull();
      const username = `back-crs-${label}`;
      const res = await redeem(redeemReq({ token, username, displayName: "Jeff again", password: PW }));
      expect(res.status).toBe(404);
      expect(await prisma.user.findUnique({ where: { username } })).toBeNull();
    });
  });
});
