import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

/**
 * Capture-pass slots and lifecycle against REAL databases: two uploads racing for the last
 * slot of a pass store exactly one, a second pass for an item closes the first, and removing
 * the creating session removes the pass.
 *
 * SQLite always runs: a throw-away database migrated with `prisma migrate deploy`, once with
 * the shipped `connection_limit=1` client and once with a pooled client where two connections
 * really race. PostgreSQL runs only when BV_TEST_POSTGRES_URL points at a scratch database
 * (it is reset with `prisma migrate reset --force`, so never point it at real data).
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-capture-pass-real-db-${process.pid}-${Date.now()}`;
  const file = `${dir}/t.db`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${file}?connection_limit=1`;
  return { dir, file };
});

vi.mock("@/lib/prisma", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require(".prisma/client-sqlite");
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const holder = { current: client };
  const prisma = new Proxy({}, { get: (_t, key) => Reflect.get(holder.current, key) });
  return { prisma, __holder: holder };
});

import type { PrismaClient } from "@prisma/client";
import * as prismaModule from "@/lib/prisma";
import { PASS_MAX_UPLOADS, closePass, createPass, findPass, returnSlot, takeSlot } from "./pass";

const holder = (prismaModule as unknown as { __holder: { current: PrismaClient } }).__holder;
const PG_URL = process.env.BV_TEST_POSTGRES_URL;
const NOW = new Date("2026-10-04T12:00:00Z");
const MINUTE = 60_000;

async function seed(client: PrismaClient) {
  await client.capturePass.deleteMany();
  await client.session.deleteMany();
  await client.user.deleteMany();
  const user = await client.user.create({
    data: { username: "ann", displayName: "Ann", passwordHash: "x", role: "USER" },
  });
  const session = await client.session.create({
    data: { userId: user.id, tokenHash: `h-${Date.now()}-${Math.random()}`, expiresAt: new Date(NOW.getTime() + 60 * MINUTE) },
  });
  return { userId: user.id, sessionId: session.id };
}

function suite(getClient: () => PrismaClient) {
  const open = async (entityId = "item-1") => {
    holder.current = getClient();
    const { userId, sessionId } = await seed(getClient());
    const made = await createPass({ entityType: "gear", entityId, createdById: userId, sessionId, now: NOW });
    return { ...made, userId, sessionId };
  };
  const row = (id: string) => getClient().capturePass.findUniqueOrThrow({ where: { id } });

  it("a second pass for one item closes the first", async () => {
    const first = await open();
    const second = await createPass({ entityType: "gear", entityId: "item-1", createdById: first.userId, sessionId: first.sessionId, now: NOW });
    expect((await row(first.id)).closedAt).not.toBeNull();
    expect((await row(second.id)).closedAt).toBeNull();
    expect(await findPass(first.token, NOW)).toEqual({ ok: false, reason: "closed" });
    expect((await findPass(second.token, NOW))?.ok).toBe(true);
  });

  it("a pass for another item stays open", async () => {
    const first = await open("item-1");
    await createPass({ entityType: "gear", entityId: "item-2", createdById: first.userId, sessionId: first.sessionId, now: NOW });
    expect((await row(first.id)).closedAt).toBeNull();
  });

  it("two takeSlot calls at 49 uploads: exactly one wins and the count ends at 50", async () => {
    const pass = await open();
    await getClient().capturePass.update({ where: { id: pass.id }, data: { uploadCount: PASS_MAX_UPLOADS - 1 } });
    const results = await Promise.all([takeSlot(pass.id, NOW), takeSlot(pass.id, NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await row(pass.id)).uploadCount).toBe(PASS_MAX_UPLOADS);
    expect(await findPass(pass.token, NOW)).toEqual({ ok: false, reason: "full" });
  });

  it("takeSlot is false on a closed pass and on an expired one", async () => {
    const pass = await open();
    expect(await takeSlot(pass.id, new Date(NOW.getTime() + 16 * MINUTE))).toBe(false);
    expect(await closePass(pass.id, NOW)).toBe(true);
    expect(await closePass(pass.id, NOW)).toBe(false);
    expect(await takeSlot(pass.id, NOW)).toBe(false);
    expect((await row(pass.id)).uploadCount).toBe(0);
  });

  it("returnSlot gives a slot back and never goes below zero", async () => {
    const pass = await open();
    expect(await takeSlot(pass.id, NOW)).toBe(true);
    await returnSlot(pass.id);
    expect((await row(pass.id)).uploadCount).toBe(0);
    await returnSlot(pass.id);
    expect((await row(pass.id)).uploadCount).toBe(0);
  });

  it("deleting the creating session deletes the pass", async () => {
    const pass = await open();
    await getClient().session.delete({ where: { id: pass.sessionId } });
    expect(await findPass(pass.token, NOW)).toBeNull();
  });

  it("a disabled creator reads as closed", async () => {
    const pass = await open();
    await getClient().user.update({ where: { id: pass.userId }, data: { disabledAt: NOW } });
    expect(await findPass(pass.token, NOW)).toEqual({ ok: false, reason: "closed" });
  });
}

describe("capture passes against real SQLite", () => {
  let shipped: PrismaClient;
  let pooled: PrismaClient;

  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${ctx.file}` },
      stdio: "pipe",
    });
    shipped = holder.current;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: SqliteClient } = require(".prisma/client-sqlite");
    pooled = new SqliteClient({ datasourceUrl: `file:${ctx.file}?connection_limit=4` }) as PrismaClient;
  }, 60_000);

  afterAll(async () => {
    await shipped?.$disconnect();
    await pooled?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  describe("shipped client (connection_limit=1)", () => suite(() => shipped));
  describe("pooled client (connection_limit=4)", () => suite(() => pooled));
});

describe.skipIf(!PG_URL)("capture passes against real PostgreSQL (BV_TEST_POSTGRES_URL)", () => {
  let pg: PrismaClient;

  beforeAll(async () => {
    execFileSync("npx", ["prisma", "migrate", "reset", "--force", "--skip-seed", "--schema", "prisma/postgres/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "postgres", DATABASE_URL: PG_URL },
      stdio: "pipe",
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: PgClient } = require("@prisma/client");
    pg = new PgClient({ datasourceUrl: `${PG_URL}${PG_URL!.includes("?") ? "&" : "?"}connection_limit=4` }) as PrismaClient;
  }, 120_000);

  afterAll(async () => {
    await pg?.$disconnect();
  });

  suite(() => pg);
});
