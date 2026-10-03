import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

/**
 * Cursor paging against a REAL SQLite database (connection_limit=1, as
 * docker-compose ships it) — the property under test (`at desc, id desc`,
 * no duplicates/gaps across pages when several events share the same `at`)
 * can't be proven against a mocked `findMany`, which only ever returns
 * whatever a test hands it. Reuses the scratch-DB pattern from
 * extension.real-db.test.ts, minus the request-context mocking that file
 * needs and this one doesn't: `auditEvent.create`/`findMany` are plain
 * passthroughs (AuditEvent is excluded from the capture extension), so no
 * actor resolution or `next/headers` mock is required.
 *
 * With AUDIT_REAL_DB_PG_URL set (a scratch PostgreSQL database), the same
 * suite runs against PostgreSQL instead.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.AUDIT_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-audit-query-real-db-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

import { prisma } from "../prisma";
import { listAuditEvents } from "./query";

const SAME_AT = new Date("2026-03-05T12:00:00.000Z");

describe(`listAuditEvents against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    if (!ctx.pg) mkdirSync(ctx.dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` },
      stdio: "pipe",
      timeout: 90_000,
    });

    // 5 events share the exact same `at`, with one distinct timestamp either
    // side, so the id-desc tiebreak is exercised in the middle of the result
    // set and at both page boundaries as the page size (2) walks through it.
    const rows: { id: string; at: Date }[] = [
      { id: "later", at: new Date("2026-03-06T00:00:00.000Z") },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `tie-${i}`, at: SAME_AT })),
      { id: "earlier", at: new Date("2026-03-04T00:00:00.000Z") },
    ];
    for (const row of rows) {
      await prisma.auditEvent.create({
        data: {
          id: row.id,
          at: row.at,
          actorId: null,
          actorName: "system",
          action: "CREATE",
          entityType: "Firearm",
          entityId: row.id,
          entityLabel: row.id,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("pages through all 7 events with no duplicates or gaps, tiebreaking equal `at` values on id desc", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 10; pages++) {
      const { events, nextCursor } = await listAuditEvents({ cursor }, 2);
      seen.push(...events.map((e) => e.id));
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    expect(pages).toBe(3); // 7 rows at 2 per page: pages 2,2,2,1 — breaks on the 4th iteration (index 3), before its increment
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(["later", "tie-4", "tie-3", "tie-2", "tie-1", "tie-0", "earlier"]);
  });

  it("a single unpaged call returns the same full order", async () => {
    const { events, nextCursor } = await listAuditEvents({}, 50);
    expect(nextCursor).toBeNull();
    expect(events.map((e) => e.id)).toEqual(["later", "tie-4", "tie-3", "tie-2", "tie-1", "tie-0", "earlier"]);
  });
  describe("q is a literal substring, never a LIKE pattern", () => {
    const LABELS = ["100% sure", "plain", "a_b", "axb", "back\\slash", "bare"];

    beforeAll(async () => {
      for (const [i, label] of LABELS.entries()) {
        await prisma.auditEvent.create({
          data: {
            id: `wild-${i}`,
            at: new Date(Date.UTC(2026, 0, 1, 0, i)),
            actorName: "system",
            action: "CREATE",
            entityType: "Wild",
            entityId: `wild-${i}`,
            entityLabel: label,
          },
        });
      }
    });

    const labelsFor = async (q: string) =>
      (await listAuditEvents({ type: "Wild", q }, 50)).events.map((e) => e.entityLabel).sort();

    it("% matches only a label containing a percent sign", async () => {
      expect(await labelsFor("%")).toEqual(["100% sure"]);
    });

    it("_ matches only a label containing an underscore", async () => {
      expect(await labelsFor("_")).toEqual(["a_b"]);
    });

    it("a backslash matches only a label containing a backslash", async () => {
      expect(await labelsFor("\\")).toEqual(["back\\slash"]);
    });

    it("finds a match that sits behind several non-matching rows even with limit 1", async () => {
      const { events, nextCursor } = await listAuditEvents({ type: "Wild", q: "_" }, 1);
      expect(events.map((e) => e.entityLabel)).toEqual(["a_b"]);
      expect(nextCursor).toBeNull();
    });

    it("case-insensitive matching still works", async () => {
      expect(await labelsFor("PLAIN")).toEqual(["plain"]);
    });
  });
});
