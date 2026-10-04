import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";

/**
 * The audit CSV export against a REAL database: byte-exact output for a fixture
 * covering the formula guard, quoting, redaction and tied timestamps; the page
 * size the route asks the database for; nothing skipped or duplicated when a
 * row is inserted between two pages. With AUDIT_REAL_DB_PG_URL set (a scratch
 * PostgreSQL database) the same suite runs on PostgreSQL.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.AUDIT_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-audit-export-real-db-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db`, admin: { denied: null as NextResponse | null } };
});

vi.mock("@/lib/server/auth", () => ({ requireAdmin: vi.fn(async () => ctx.admin.denied) }));

import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const BASE = Date.UTC(2026, 2, 5, 12, 0, 0);

function seed(id: string, at: number, extra: Record<string, unknown> = {}) {
  return prisma.auditEvent.create({
    data: {
      id,
      at: new Date(at),
      actorName: "system",
      action: "CREATE",
      entityType: "Firearm",
      entityId: id,
      entityLabel: id,
      ...extra,
    },
  });
}

function get(query = "") {
  return new NextRequest(`http://localhost/api/admin/audit/export${query}`);
}

async function body(res: Response): Promise<string> {
  // text() would strip the BOM; read the raw bytes instead.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
}

describe(`audit CSV export against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    if (!ctx.pg) mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` }, stdio: "pipe", timeout: 90_000 },
    );
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("small fixture: exact bytes", async () => {
    await seed("fx-a", BASE + 3000, { entityLabel: "=SUM(A1)", actorIp: "10.0.0.1" });
    await seed("fx-b", BASE + 2000, { entityLabel: 'say "hi", ok', actorName: "Ann, A" });
    await seed("fx-c", BASE + 1000, { entityLabel: "ÜBER\nline", changes: JSON.stringify({ passwordHash: { from: "old", to: "new" }, name: { from: "a", to: "b" } }) });
    await seed("fx-d", BASE + 1000, { entityLabel: null, action: "LOGIN", entityType: null, entityId: null, changes: "not json" });

    const res = await GET(get());
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toBe(GOLDEN);
  });

  describe("paging", () => {
    const BULK = 3000;
    const idOf = (i: number) => `bulk-${String(i).padStart(5, "0")}`;
    const real = prisma.auditEvent.findMany.bind(prisma.auditEvent);
    let spy: MockInstance | undefined;
    // The spy is installed once and pointed back at the real query between
    // tests; restoring it would remove the method from the Prisma client.
    const intercept = (impl: (args: never) => unknown) => {
      spy ??= vi.spyOn(prisma.auditEvent, "findMany");
      spy.mockClear();
      spy.mockImplementation(impl as never);
      return spy;
    };

    afterEach(() => {
      spy?.mockImplementation(real as never);
    });

    const idsIn = (csv: string) =>
      csv
        .split("\r\n")
        .slice(1)
        .map((line) => /bulk-\d+|mid-\w+/.exec(line)?.[0] ?? "");

    beforeAll(async () => {
      await prisma.auditEvent.createMany({
        data: Array.from({ length: BULK }, (_, i) => ({
          id: idOf(i),
          at: new Date(BASE + 10_000_000 + Math.floor(i / 3) * 1000), // three rows per instant: ties
          actorName: "system",
          action: "CREATE",
          entityType: "Bulk",
          entityId: idOf(i),
          entityLabel: idOf(i),
        })),
      });
    }, 120_000);

    it("never asks the database for more than one page, and pages lazily", async () => {
      const takes: number[] = [];
      intercept((args: { take?: number }) => {
        takes.push(args.take ?? -1);
        return real(args as never);
      });

      const res = await GET(get("?type=Bulk"));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      let text = decoder.decode((await reader.read()).value);
      expect(takes.length).toBeLessThan(3); // nothing has been read ahead of the consumer
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      const ids = idsIn(text);
      expect(ids).toHaveLength(BULK);
      expect(new Set(ids).size).toBe(BULK);
      expect(takes).toHaveLength(BULK / 500); // 6 pages of 500, each fetched as 500 + 1
      expect(Math.max(...takes)).toBeLessThanOrEqual(501);
    });

    it("skips and repeats nothing when rows are inserted between two pages", async () => {
      let calls = 0;
      intercept(async (args: never) => {
        if (++calls === 2) {
          // One row newer than everything and one in the middle of the unread region.
          await seed("mid-newer", BASE + 99_000_000, { entityType: "Bulk" });
          await seed("mid-inside", BASE + 10_000_000 + 1_000_000 / 3, { entityType: "Bulk", entityLabel: "mid-inside" });
        }
        return real(args);
      });

      const ids = idsIn(await body(await GET(get("?type=Bulk"))));

      const original = ids.filter((id) => id.startsWith("bulk-"));
      expect(original).toHaveLength(BULK);
      expect(new Set(original).size).toBe(BULK);
      // newest first: the fixture's instants and ids both rise together, so ids descend
      expect(original).toEqual([...original].sort().reverse());
      expect(ids.filter((id) => id === "mid-newer")).toHaveLength(0);
      expect(ids.filter((id) => id === "mid-inside")).toHaveLength(1);
    });

    it("a database error on a later page fails the download instead of truncating it", async () => {
      let calls = 0;
      intercept((args: never) => {
        if (++calls === 2) return Promise.reject(new Error("db went away"));
        return real(args);
      });

      const res = await GET(get("?type=Bulk"));
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow("db went away");
    });

    it("a database error on the first page is an ordinary failure before any response exists", async () => {
      intercept(() => Promise.reject(new Error("db down")));
      await expect(GET(get("?type=Bulk"))).rejects.toThrow("db down");
    });

    it("a non-admin gets 403 before any row is read", async () => {
      const spy = intercept(real as never);
      ctx.admin.denied = NextResponse.json({ error: "Admins only" }, { status: 403 });
      try {
        const res = await GET(get("?type=Bulk"));
        expect(res.status).toBe(403);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        ctx.admin.denied = null;
      }
    });
  });

  describe.skipIf(ctx.pg)("a wildcard search on SQLite whose pages come back empty", () => {
    const ROWS = 7000; // more than one scan's worth, so the first pages hold no match
    const matches = ["rare_10", "rare_20", "rare_30"];

    beforeAll(async () => {
      await prisma.auditEvent.createMany({
        data: Array.from({ length: ROWS }, (_, i) => ({
          id: `rare-${String(i).padStart(5, "0")}`,
          at: new Date(Date.UTC(2024, 0, 1) + i * 1000),
          actorName: "system",
          action: "CREATE",
          entityType: "Rare",
          entityId: String(i),
          entityLabel: [10, 20, 30].includes(i) ? `rare_${i}` : `rare-${i}`,
        })),
      });
    }, 120_000);

    it("still exports every match once, in order, after empty pages that carry a cursor", async () => {
      const res = await GET(get("?type=Rare&q=_"));
      const lines = (await body(res)).split("\r\n");
      expect(lines[0]).toBe("\uFEFFat,actor,ip,action,type,item,changes");
      expect(lines.slice(1).map((line) => line.split(",")[5])).toEqual([...matches].reverse());
    });
  });
});

// Captured from the previous collect-everything implementation, before it was replaced.
const GOLDEN =
  "\uFEFFat,actor,ip,action,type,item,changes\r\n2026-03-05T12:00:03.000Z,system,10.0.0.1,CREATE,Firearm,'=SUM(A1),\r\n2026-03-05T12:00:02.000Z,\"Ann, A\",,CREATE,Firearm,\"say \"\"hi\"\", ok\",\r\n2026-03-05T12:00:01.000Z,system,,LOGIN,,,\r\n2026-03-05T12:00:01.000Z,system,,CREATE,Firearm,\"ÜBER\nline\",\"{\"\"passwordHash\"\":\"\"[redacted]\"\",\"\"name\"\":{\"\"from\"\":\"\"a\"\",\"\"to\"\":\"\"b\"\"}}\"";
