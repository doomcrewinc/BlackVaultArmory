import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

/**
 * Last-admin protection against a REAL database (Review Focus #5): two admins demoting each
 * other at the same moment must leave at least one active admin.
 *
 * SQLite always runs: a throw-away database migrated with `prisma migrate deploy`, the shipped
 * `connection_limit=1` singleton plus a pooled client where two connections really race.
 *
 * PostgreSQL runs only when BV_TEST_POSTGRES_URL points at a scratch database (it is reset with
 * `prisma migrate reset --force`, so never point it at real data). That is the case the
 * Serializable isolation level exists for: under READ COMMITTED both demotions would commit.
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-admins-real-db-${process.pid}-${Date.now()}`;
  const file = `${dir}/t.db`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${file}?connection_limit=1`;
  return { dir, file };
});

vi.mock("@/lib/prisma", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require(".prisma/client-sqlite");
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  // Tests swap the client under test through this holder.
  const holder = { current: client };
  const prisma = new Proxy({}, { get: (_t, key) => Reflect.get(holder.current, key) });
  return { prisma, __holder: holder };
});

import type { PrismaClient } from "@prisma/client";
import * as prismaModule from "@/lib/prisma";
import { changeRoleOrStatus } from "./admins";

const holder = (prismaModule as unknown as { __holder: { current: PrismaClient } }).__holder;
const PG_URL = process.env.BV_TEST_POSTGRES_URL;

async function seedTwoAdmins(client: PrismaClient) {
  await client.session.deleteMany();
  await client.authToken.deleteMany();
  await client.user.deleteMany();
  const a = await client.user.create({ data: { username: "alice", displayName: "Alice", passwordHash: "x", role: "ADMIN" } });
  const b = await client.user.create({ data: { username: "bob", displayName: "Bob", passwordHash: "x", role: "ADMIN" } });
  return { a: a.id, b: b.id };
}

const activeAdmins = (client: PrismaClient) => client.user.count({ where: { role: "ADMIN", disabledAt: null } });

async function raceTwo(client: PrismaClient, change: (target: string, actor: string) => ReturnType<typeof changeRoleOrStatus>) {
  const { a, b } = await seedTwoAdmins(client);
  const results = await Promise.allSettled([change(a, b), change(b, a)]);
  return { results, admins: await activeAdmins(client) };
}

function expectOneWinner(results: PromiseSettledResult<Awaited<ReturnType<typeof changeRoleOrStatus>>>[]) {
  const ok = results.filter((r) => r.status === "fulfilled" && r.value.ok);
  const refused = results.filter((r) => r.status === "fulfilled" && !r.value.ok && r.value.status === 409);
  expect(ok).toHaveLength(1);
  expect(refused).toHaveLength(1);
}

describe("changeRoleOrStatus against real SQLite", () => {
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

  beforeEach(() => {
    holder.current = shipped;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("sole admin cannot demote or disable self", async () => {
    const { a, b } = await seedTwoAdmins(shipped);
    await shipped.user.update({ where: { id: b }, data: { role: "USER" } });
    expect(await changeRoleOrStatus(a, { role: "USER" }, a)).toMatchObject({ ok: false, status: 409 });
    expect(await changeRoleOrStatus(a, { disabled: true }, a)).toMatchObject({ ok: false, status: 409 });
    expect(await activeAdmins(shipped)).toBe(1);
  });

  it("two admins demoting each other concurrently (shipped pool of 1): one wins, one 409", async () => {
    const { results, admins } = await raceTwo(shipped, (t, actor) => changeRoleOrStatus(t, { role: "USER" }, actor));
    expectOneWinner(results);
    expect(admins).toBe(1);
  });

  it("two admins disabling each other concurrently (shipped pool of 1): one wins, one 409", async () => {
    const { results, admins } = await raceTwo(shipped, (t, actor) => changeRoleOrStatus(t, { disabled: true }, actor));
    expectOneWinner(results);
    expect(admins).toBe(1);
  });

  it("two admins demoting each other concurrently on a pooled client (4 connections): one active admin remains", async () => {
    holder.current = pooled;
    const { results, admins } = await raceTwo(pooled, (t, actor) => changeRoleOrStatus(t, { role: "USER" }, actor));
    expect(admins).toBe(1);
    expectOneWinner(results);
  });
});

describe.skipIf(!PG_URL)("changeRoleOrStatus against real PostgreSQL (BV_TEST_POSTGRES_URL)", () => {
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
    holder.current = pg;
  }, 120_000);

  afterAll(async () => {
    await pg?.$disconnect();
  });

  beforeEach(() => {
    holder.current = pg;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it.each(Array.from({ length: 10 }, (_, i) => i))(
    "two admins demoting each other concurrently: exactly one active admin remains (run %i)",
    async () => {
      const { results, admins } = await raceTwo(pg, (t, actor) => changeRoleOrStatus(t, { role: "USER" }, actor));
      expect(admins).toBe(1);
      expectOneWinner(results);
    },
  );

  it.each(Array.from({ length: 5 }, (_, i) => i))(
    "one demotes, the other disables, concurrently: exactly one active admin remains (run %i)",
    async () => {
      const { a, b } = await seedTwoAdmins(pg);
      const results = await Promise.allSettled([
        changeRoleOrStatus(a, { role: "USER" }, b),
        changeRoleOrStatus(b, { disabled: true }, a),
      ]);
      expect(await activeAdmins(pg)).toBe(1);
      expectOneWinner(results);
    },
  );
});
