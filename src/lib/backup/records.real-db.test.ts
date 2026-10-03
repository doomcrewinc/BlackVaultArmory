import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

/**
 * collectBackupRecords against a REAL database: every table is read from one
 * consistent view. A second writer inserts a parent row and its child between
 * two table reads (through the module's internal read hook, not timing); the
 * collected set must hold both or neither.
 * - default: a throw-away SQLite file with `connection_limit=1`;
 * - with ENCRYPTION_REAL_DB_PG_URL set, the same test on PostgreSQL.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.ENCRYPTION_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-records-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => null),
  requireAuth: vi.fn(async () => null),
  requireAdmin: vi.fn(async () => null),
}));

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient, prisma } from "@/lib/prisma";
import { collectBackupRecords, backupRecordHooks } from "./records";

let raw: PrismaClient;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

describe(`collectBackupRecords against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` }, stdio: "pipe", timeout: 90_000 },
    );
    raw = createRawPrismaClient();
    await within(20_000, raw.firearm.deleteMany());
  }, 120_000);

  afterAll(async () => {
    backupRecordHooks.afterRead = null;
    await within(20_000, raw.firearm.deleteMany()).catch(() => undefined);
    await prisma.$disconnect();
    await raw?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("holds a build and its slots both or neither when a writer lands between two table reads", async () => {
    const firearm = await within(
      20_000,
      prisma.firearm.create({
        data: {
          name: "Records test rifle",
          manufacturer: "Ruger",
          model: "10/22",
          caliber: "22LR",
          serialNumber: "SER-RECORDS-1",
          type: "RIFLE",
          acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
        },
      }),
    );

    let write: Promise<unknown> | null = null;
    backupRecordHooks.afterRead = async (key) => {
      if (key !== "builds" || write) return;
      // Parent and child in one atomic write, from a second connection. Under
      // a read transaction on SQLite the commit may wait for it to end, so
      // the hook waits only briefly and the test awaits the write afterwards.
      write = raw.build.create({
        data: { name: "Late build", firearmId: firearm.id, slots: { create: [{ slotType: "MUZZLE" }] } },
      });
      await Promise.race([write, new Promise((r) => setTimeout(r, 1_500))]);
    };

    const records = await within(60_000, collectBackupRecords());
    backupRecordHooks.afterRead = null;
    await within(30_000, write ?? Promise.reject(new Error("hook never ran")));

    // Reads on the transaction client still decrypt.
    expect((records.firearms as { serialNumber: string }[])[0].serialNumber).toBe("SER-RECORDS-1");

    const buildIds = new Set((records.builds as { id: string }[]).map((b) => b.id));
    const slotBuildIds = (records.buildSlots as { buildId: string }[]).map((s) => s.buildId);
    for (const id of slotBuildIds) expect(buildIds.has(id), `slot references build ${id} missing from the backup`).toBe(true);
  }, 120_000);
});
