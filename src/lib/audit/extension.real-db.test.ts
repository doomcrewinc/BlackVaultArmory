import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * The audit capture extension against a REAL database — route tests that
 * `vi.mock("@/lib/prisma")` replace the whole client and bypass it, so they
 * cannot prove anything about auditing.
 *
 * Default: a throw-away SQLite file in a temp dir with `connection_limit=1`,
 * exactly as docker-compose ships SQLite, migrated with `prisma migrate
 * deploy` and deleted afterwards. The dev database is never touched.
 * With AUDIT_REAL_DB_PG_URL set (a scratch PostgreSQL database), the same
 * suite runs against PostgreSQL instead.
 *
 * Every Prisma call that could deadlock is raced against a timer, so a
 * deadlock is a failing test, not a hung run.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.AUDIT_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-audit-real-db-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

// Request context. With `current` null the REAL next/headers runs, which
// throws "called outside a request scope" — the same path startup jobs take.
const req = vi.hoisted(() => ({
  current: null as Headers | null,
  user: null as { id: string; username: string; displayName: string; role: "ADMIN" | "USER"; sessionId: string } | null,
  userLookups: 0,
}));

vi.mock("next/headers", async (importActual) => {
  const actual = await importActual<typeof import("next/headers")>();
  return { ...actual, headers: async () => req.current ?? actual.headers() };
});

vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => {
    req.userLookups++;
    return req.user;
  }),
  requireAuth: vi.fn(async () => null),
  requireAdmin: vi.fn(async () => null),
}));

// Outside Next, revalidateTag throws; the route would then 500 after committing.
vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({ revalidateDashboardData: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { withoutRowAudit } from "@/lib/audit/context";
import { REDACTED } from "@/lib/audit/redact";
import { runConfiguredDateMigration } from "@/lib/date-migration";
import { BACKUP_MODELS } from "@/lib/backup/models";
import { DELETE as deleteFirearmRoute } from "@/app/api/firearms/[id]/route";
import { POST as restoreRoute } from "@/app/api/backup/restore/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { hashPassword } from "@/lib/auth/password";
import { changeRoleOrStatus } from "@/lib/auth/admins";

type Event = Awaited<ReturnType<typeof prisma.auditEvent.findMany>>[number];

const SERIAL_MARK = "SER-SECRET-";
let serialSeq = 0;
let alice: { id: string };

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

async function eventIds(): Promise<Set<string>> {
  return new Set((await prisma.auditEvent.findMany({ select: { id: true } })).map((e) => e.id));
}

/** The audit events `fn` produced (committed or not by the time it settles). */
async function eventsFrom(fn: () => Promise<unknown>, ms = 8_000): Promise<Event[]> {
  const before = await eventIds();
  await within(ms, fn());
  return (await prisma.auditEvent.findMany({ orderBy: { at: "asc" } })).filter((e) => !before.has(e.id));
}

async function newEventsSince(before: Set<string>): Promise<Event[]> {
  return (await prisma.auditEvent.findMany({ orderBy: { at: "asc" } })).filter((e) => !before.has(e.id));
}

function firearmData(overrides: Record<string, unknown> = {}) {
  serialSeq++;
  return {
    name: `Glock ${serialSeq}`,
    manufacturer: "Glock",
    model: "19",
    caliber: "9mm",
    serialNumber: `${SERIAL_MARK}${serialSeq}`,
    type: "PISTOL",
    acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function changesOf(e: Event): Record<string, unknown> {
  return JSON.parse(e.changes ?? "null");
}

describe(`audit capture against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    if (!ctx.pg) mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` },
        stdio: "pipe",
        timeout: 90_000,
      },
    );
    alice = await prisma.user.create({
      data: { username: "alice", displayName: "Alice A", passwordHash: "x", role: "USER" },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    if (!ctx.pg) rmSync(ctx.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    req.current = null;
    req.user = null;
    req.userLookups = 0;
    delete process.env.TRUSTED_PROXIES;
  });

  // ─── Operations ────────────────────────────────────────────────

  it("create → one CREATE with the row's fields, serial redacted, actor system outside a request", async () => {
    let id = "";
    const events = await eventsFrom(async () => {
      id = (await prisma.firearm.create({ data: firearmData({ name: "Create Me" }) })).id;
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({
      action: "CREATE",
      entityType: "Firearm",
      entityId: id,
      entityLabel: "Create Me (9mm)",
      actorId: null,
      actorName: "system",
      actorIp: null,
    });
    const changes = changesOf(e);
    expect(changes).toMatchObject({ id, name: "Create Me", caliber: "9mm", serialNumber: REDACTED });
  });

  it("create with a select that omits id: still one CREATE, and the caller's result has no id", async () => {
    let result: Record<string, unknown> = {};
    const events = await eventsFrom(async () => {
      result = await prisma.firearm.create({ data: firearmData({ name: "Selected" }), select: { name: true } });
    });
    expect(result).toEqual({ name: "Selected" });
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBeTruthy();
    expect(changesOf(events[0])).toMatchObject({ name: "Selected", serialNumber: REDACTED });
  });

  it("update → one UPDATE with only the changed fields, before and after", async () => {
    const f = await prisma.firearm.create({ data: firearmData({ name: "Before" }) });
    const events = await eventsFrom(() =>
      prisma.firearm.update({ where: { id: f.id }, data: { name: "After", notes: "cleaned" } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "UPDATE", entityType: "Firearm", entityId: f.id, entityLabel: "After (9mm)" });
    expect(changesOf(events[0])).toEqual({ name: ["Before", "After"], notes: [null, "cleaned"] });
  });

  it("a save with the values the row already has logs nothing (Review Focus #3)", async () => {
    const f = await prisma.firearm.create({ data: firearmData({ name: "Same", notes: "n" }) });
    const events = await eventsFrom(() =>
      prisma.firearm.update({
        where: { id: f.id },
        data: { name: "Same", notes: "n", caliber: "9mm", acquisitionDate: new Date("2024-01-01T00:00:00.000Z") },
      }),
    );
    expect(events).toEqual([]);
  });

  it("a changed serial is recorded as changed, never its value", async () => {
    const f = await prisma.firearm.create({ data: firearmData() });
    const events = await eventsFrom(() =>
      prisma.firearm.update({ where: { id: f.id }, data: { serialNumber: `${SERIAL_MARK}changed` } }),
    );
    // The fingerprint moves with the serial (field encryption) and is redacted the same way.
    expect(changesOf(events[0])).toEqual({ serialNumber: [REDACTED, REDACTED], serialNumberHash: [REDACTED, REDACTED] });
  });

  it("updateMany → one UPDATE per affected row", async () => {
    const a = await prisma.supply.create({ data: { name: "Batch A", category: "CLEANING", unit: "OZ", quantity: 1 } });
    const b = await prisma.supply.create({ data: { name: "Batch B", category: "CLEANING", unit: "OZ", quantity: 2 } });
    const events = await eventsFrom(() =>
      prisma.supply.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { storageLocation: "Shelf 3" } }),
    );
    expect(events.map((e) => e.entityId).sort()).toEqual([a.id, b.id].sort());
    for (const e of events) {
      expect(e.action).toBe("UPDATE");
      expect(changesOf(e)).toEqual({ storageLocation: [null, "Shelf 3"] });
    }
  });

  it("delete of a firearm with 3 maintenance logs → exactly one DELETE with _children.MaintenanceLog === 3 (Review Focus #2)", async () => {
    const f = await prisma.firearm.create({ data: firearmData({ name: "Doomed" }) });
    for (let i = 0; i < 3; i++) {
      await prisma.maintenanceLog.create({ data: { firearmId: f.id, date: new Date("2024-02-01T00:00:00.000Z"), notes: `log ${i}` } });
    }
    const events = await eventsFrom(() => prisma.firearm.delete({ where: { id: f.id } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "DELETE", entityType: "Firearm", entityId: f.id, entityLabel: "Doomed (9mm)" });
    const changes = changesOf(events[0]);
    expect(changes._children).toEqual({ MaintenanceLog: 3 });
    expect(changes).toMatchObject({ name: "Doomed", serialNumber: REDACTED });
    expect(await prisma.maintenanceLog.count({ where: { firearmId: f.id } })).toBe(0);
  });

  it("delete counts cascades transitively (build → slots) and leaves _children out when there are none", async () => {
    const f = await prisma.firearm.create({
      data: firearmData({ builds: { create: [{ name: "B1", slots: { create: [{ slotType: "MUZZLE" }, { slotType: "OPTIC" }] } }] } }),
    });
    const [withKids] = await eventsFrom(() => prisma.firearm.delete({ where: { id: f.id } }));
    expect(changesOf(withKids)._children).toEqual({ Build: 1, BuildSlot: 2 });

    const bare = await prisma.firearm.create({ data: firearmData() });
    const [noKids] = await eventsFrom(() => prisma.firearm.delete({ where: { id: bare.id } }));
    expect(changesOf(noKids)).not.toHaveProperty("_children");
  });

  it("deleteMany → one DELETE per row, each with its snapshot", async () => {
    const a = await prisma.kit.create({ data: { name: "Kit A", category: "RANGE" } });
    const b = await prisma.kit.create({ data: { name: "Kit B", category: "RANGE", items: { create: [{ label: "tape" }] } } });
    const events = await eventsFrom(() => prisma.kit.deleteMany({ where: { id: { in: [a.id, b.id] } } }));
    expect(events.map((e) => e.entityLabel).sort()).toEqual(["Kit A", "Kit B"]);
    const kitB = events.find((e) => e.entityId === b.id)!;
    expect(changesOf(kitB)._children).toEqual({ KitItem: 1 });
    expect(events.every((e) => e.action === "DELETE")).toBe(true);
  });

  it("upsert → CREATE when the row is new, UPDATE (changed fields only) when it exists", async () => {
    await prisma.appSettings.deleteMany();
    const created = await eventsFrom(() =>
      prisma.appSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", defaultCurrency: "USD" }, update: {} }),
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ action: "CREATE", entityType: "AppSettings", entityId: "singleton" });

    const updated = await eventsFrom(() =>
      prisma.appSettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton" },
        update: { defaultCurrency: "EUR", googleCseApiKey: "k-123" },
      }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].action).toBe("UPDATE");
    expect(changesOf(updated[0])).toEqual({ defaultCurrency: ["USD", "EUR"], googleCseApiKey: [REDACTED, REDACTED] });
    expect(updated[0].changes).not.toContain("k-123");

    const noop = await eventsFrom(() =>
      prisma.appSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: { defaultCurrency: "EUR" } }),
    );
    expect(noop).toEqual([]);
  });

  it("nested create → one CREATE on the parent with the child data inside changes, no child entries", async () => {
    const events = await eventsFrom(() =>
      prisma.accessory.create({
        data: {
          name: "Light",
          manufacturer: "Surefire",
          type: "LIGHT",
          serialNumber: `${SERIAL_MARK}acc`,
          batteryChangeLogs: { create: [{ batteryType: "CR123", notes: "first" }] },
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "CREATE", entityType: "Accessory", entityLabel: "Light (LIGHT)" });
    const changes = changesOf(events[0]);
    expect(changes.batteryChangeLogs).toEqual({ create: [{ batteryType: "CR123", notes: "first" }] });
    expect(changes.serialNumber).toBe(REDACTED);
  });

  it("excluded models (User, Session) produce no entries", async () => {
    const events = await eventsFrom(async () => {
      const u = await prisma.user.create({ data: { username: "bob", displayName: "Bob", passwordHash: "x" } });
      await prisma.user.update({ where: { id: u.id }, data: { displayName: "Bobby" } });
      await prisma.session.create({ data: { userId: u.id, tokenHash: "h-bob", expiresAt: new Date(Date.now() + 1e6) } });
      await prisma.session.deleteMany({ where: { userId: u.id } });
    });
    expect(events).toEqual([]);
  });

  // ─── Append-only ───────────────────────────────────────────────

  it("AuditEvent update/updateMany/upsert/delete/deleteMany throw; entries are unchanged", async () => {
    const [e] = await eventsFrom(() => prisma.supply.create({ data: { name: "Anchor", category: "OTHER", unit: "COUNT" } }));
    const attempts: Array<() => Promise<unknown>> = [
      () => prisma.auditEvent.update({ where: { id: e.id }, data: { actorName: "nobody" } }),
      () => prisma.auditEvent.updateMany({ data: { actorName: "nobody" } }),
      () => prisma.auditEvent.upsert({ where: { id: e.id }, create: { actorName: "x", action: "CREATE" }, update: { actorName: "nobody" } }),
      () => prisma.auditEvent.delete({ where: { id: e.id } }),
      () => prisma.auditEvent.deleteMany(),
      () => prisma.$transaction((tx) => tx.auditEvent.deleteMany()),
    ];
    for (const attempt of attempts) await expect(within(5_000, attempt())).rejects.toThrow("AuditEvent is append-only");
    expect(await prisma.auditEvent.findUnique({ where: { id: e.id } })).toEqual(e);
  });

  // ─── Transactions and atomicity ────────────────────────────────

  it("interactive $transaction: changes and audit rows commit together", async () => {
    const events = await eventsFrom(() =>
      prisma.$transaction(async (tx) => {
        await tx.supply.create({ data: { name: "Tx 1", category: "OTHER", unit: "COUNT" } });
        await tx.supply.create({ data: { name: "Tx 2", category: "OTHER", unit: "COUNT" } });
      }),
    );
    expect(events.map((e) => e.entityLabel).sort()).toEqual(["Tx 1", "Tx 2"]);
  });

  it("a throw inside $transaction rolls back the change AND its audit row, within 5 s (Review Focus #1)", async () => {
    const before = await eventIds();
    await expect(
      within(
        5_000,
        prisma.$transaction(async (tx) => {
          await tx.supply.create({ data: { name: "Rolled back", category: "OTHER", unit: "COUNT" } });
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(await prisma.supply.count({ where: { name: "Rolled back" } })).toBe(0);
    expect(await newEventsSince(before)).toEqual([]);
  });

  it("the OUTER client used inside a callback joins the transaction: no deadlock, rolls back together", async () => {
    const before = await eventIds();
    await expect(
      within(
        5_000,
        prisma.$transaction(async () => {
          await prisma.supply.create({ data: { name: "Outer by mistake", category: "OTHER", unit: "COUNT" } });
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(await prisma.supply.count({ where: { name: "Outer by mistake" } })).toBe(0);
    expect(await newEventsSince(before)).toEqual([]);
  });

  it("nested $transaction flattens into the open one: an outer throw rolls back both", async () => {
    const before = await eventIds();
    await expect(
      within(
        5_000,
        prisma.$transaction(async (tx) => {
          await tx.supply.create({ data: { name: "Outer", category: "OTHER", unit: "COUNT" } });
          await prisma.$transaction(async (inner) => {
            await inner.supply.create({ data: { name: "Inner", category: "OTHER", unit: "COUNT" } });
          });
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(await prisma.supply.count({ where: { name: { in: ["Outer", "Inner"] } } })).toBe(0);
    expect(await newEventsSince(before)).toEqual([]);
  });

  it("array-form $transaction is atomic: commits with its audit rows, and a failing item rolls every item back", async () => {
    const ok = await eventsFrom(() =>
      prisma.$transaction([
        prisma.supply.create({ data: { name: "Arr 1", category: "OTHER", unit: "COUNT" } }),
        prisma.supply.create({ data: { name: "Arr 2", category: "OTHER", unit: "COUNT" } }),
      ]),
    );
    expect(ok.map((e) => e.entityLabel).sort()).toEqual(["Arr 1", "Arr 2"]);

    const before = await eventIds();
    await expect(
      within(
        5_000,
        prisma.$transaction([
          prisma.supply.create({ data: { name: "Arr 3", category: "OTHER", unit: "COUNT" } }),
          prisma.supply.update({ where: { id: "does-not-exist" }, data: { name: "x" } }),
        ]),
      ),
    ).rejects.toThrow();
    expect(await prisma.supply.count({ where: { name: "Arr 3" } })).toBe(0);
    expect(await newEventsSince(before)).toEqual([]);
  });

  it("a failing audit insert rolls the change back (single write outside a transaction)", async () => {
    // A signed-in user whose id is not in User: the AuditEvent.actorId foreign key rejects the insert.
    req.current = new Headers();
    req.user = { id: "no-such-user", username: "ghost", displayName: "Ghost", role: "USER", sessionId: "s" };
    await expect(
      within(5_000, prisma.supply.create({ data: { name: "Audit fails", category: "OTHER", unit: "COUNT" } })),
    ).rejects.toThrow();
    expect(await prisma.supply.count({ where: { name: "Audit fails" } })).toBe(0);
  });

  it("a single write queued behind a 3 s transaction still succeeds (maxWait 10 s, spike A13b)", async () => {
    const before = await eventIds();
    const results = await within(
      9_000,
      Promise.allSettled([
        prisma.$transaction(async (tx) => {
          await tx.supply.create({ data: { name: "Slow tx", category: "OTHER", unit: "COUNT" } });
          await new Promise((r) => setTimeout(r, 3_000));
        }),
        (async () => {
          await new Promise((r) => setTimeout(r, 100));
          return prisma.supply.create({ data: { name: "Queued", category: "OTHER", unit: "COUNT" } });
        })(),
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await newEventsSince(before)).map((e) => e.entityLabel).sort()).toEqual(["Queued", "Slow tx"]);
  }, 15_000);

  // ─── Suppression ───────────────────────────────────────────────

  it("withoutRowAudit suppresses single writes and writes in transactions it opens", async () => {
    const events = await eventsFrom(() =>
      withoutRowAudit(async () => {
        await prisma.supply.create({ data: { name: "Quiet 1", category: "OTHER", unit: "COUNT" } });
        await prisma.$transaction(async (tx) => {
          await tx.supply.create({ data: { name: "Quiet 2", category: "OTHER", unit: "COUNT" } });
        });
        await prisma.supply.deleteMany({ where: { name: { in: ["Quiet 1", "Quiet 2"] } } });
      }),
    );
    expect(events).toEqual([]);
    // Suppression is scoped: the next write outside it is audited again.
    const after = await eventsFrom(() => prisma.supply.create({ data: { name: "Loud", category: "OTHER", unit: "COUNT" } }));
    expect(after).toHaveLength(1);
  });

  // ─── Actor ─────────────────────────────────────────────────────

  it("in a request: the signed-in user, IP from the trusted proxy, one session lookup for the whole request", async () => {
    process.env.TRUSTED_PROXIES = "10.0.0.1";
    req.current = new Headers({ "x-forwarded-for": "1.2.3.4, 10.9.8.7" });
    req.user = { id: alice.id, username: "alice", displayName: "Alice A", role: "USER", sessionId: "s1" };

    const events = await eventsFrom(async () => {
      const s = await prisma.supply.create({ data: { name: "Mine", category: "OTHER", unit: "COUNT" } });
      await prisma.supply.update({ where: { id: s.id }, data: { quantity: 5 } });
      await Promise.all([
        prisma.supply.create({ data: { name: "Mine 2", category: "OTHER", unit: "COUNT" } }),
        prisma.$transaction(async (tx) => {
          await tx.supply.create({ data: { name: "Mine 3", category: "OTHER", unit: "COUNT" } });
        }),
      ]);
    }, 10_000);

    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(e).toMatchObject({ actorId: alice.id, actorName: "Alice A (@alice)", actorIp: "10.9.8.7" });
    }
    expect(req.userLookups).toBe(1);

    // A new request (a new headers object) looks the user up again.
    req.current = new Headers();
    await prisma.supply.create({ data: { name: "Next request", category: "OTHER", unit: "COUNT" } });
    expect(req.userLookups).toBe(2);
  });

  it("in a request with no signed-in user: anonymous; without trusted proxies the IP is null", async () => {
    req.current = new Headers({ "x-forwarded-for": "1.2.3.4" });
    const [e] = await eventsFrom(() => prisma.supply.create({ data: { name: "Anon", category: "OTHER", unit: "COUNT" } }));
    expect(e).toMatchObject({ actorId: null, actorName: "anonymous", actorIp: null });
  });

  it("the startup date migration (no request) is recorded as system, not suppressed (Review Focus #5)", async () => {
    const f = await prisma.firearm.create({
      data: firearmData({ name: "Legacy", acquisitionDate: new Date("2020-03-04T15:30:00.000Z") }),
    });
    const events = await eventsFrom(() => runConfiguredDateMigration("startup"), 20_000);
    const mine = events.filter((e) => e.entityId === f.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: "UPDATE", actorName: "system", actorId: null });
    expect(changesOf(mine[0])).toHaveProperty("acquisitionDate");
  });

  // ─── Routes ────────────────────────────────────────────────────

  it("DELETE /api/firearms/:id with deleteAccessories: the accessories get their own DELETEs, the firearm one DELETE with cascaded counts", async () => {
    const acc = await prisma.accessory.create({ data: { name: "Can", manufacturer: "SilencerCo", type: "SUPPRESSOR" } });
    const f = await prisma.firearm.create({
      data: firearmData({
        name: "Route Doomed",
        builds: { create: [{ name: "Build", slots: { create: [{ slotType: "SUPPRESSOR", accessoryId: acc.id }, { slotType: "OPTIC" }] } }] },
        maintenanceLogs: { create: [{ date: new Date("2024-02-01T00:00:00.000Z"), notes: "x" }] },
      }),
    });
    const events = await eventsFrom(() =>
      deleteFirearmRoute(
        new NextRequest(`http://localhost/api/firearms/${f.id}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deleteAccessories: true }),
        }),
        { params: Promise.resolve({ id: f.id }) },
      ),
    );
    const byType = (t: string) => events.filter((e) => e.entityType === t);
    expect(byType("Accessory")).toHaveLength(1);
    expect(byType("Accessory")[0]).toMatchObject({ action: "DELETE", entityId: acc.id });
    expect(byType("Firearm")).toHaveLength(1);
    // The explicit accessory delete ran first (SetNull on the slot), so only DB-cascade rows are counted.
    expect(changesOf(byType("Firearm")[0])._children).toEqual({ Build: 1, BuildSlot: 2, MaintenanceLog: 1 });
    expect(events).toHaveLength(2);
  });

  // ─── Redaction, across everything above ────────────────────────

  it("no stored changes string contains a serial number value", async () => {
    const all = await prisma.auditEvent.findMany();
    expect(all.length).toBeGreaterThan(20);
    for (const e of all) expect(e.changes ?? "").not.toContain(SERIAL_MARK);
  });

  // ─── Restore (last: it replaces every inventory table) ─────────

  it("restore, including its post-restore date migration, produces zero row-level entries and exactly one RESTORE event", async () => {
    const body: Record<string, unknown> = { meta: { version: "1.0" } };
    for (const { key } of BACKUP_MODELS) body[key] = [];
    body.firearms = [
      {
        id: "restored-1",
        name: "Restored",
        manufacturer: "Colt",
        model: "1911",
        caliber: ".45",
        serialNumber: `${SERIAL_MARK}restored`,
        type: "PISTOL",
        nfaClass: "NONE",
        // Legacy (not UTC midnight): the date migration after restore normalises it.
        acquisitionDate: "2019-06-07T18:45:00.000Z",
      },
    ];
    const before = await eventIds();
    const res = await within(
      20_000,
      restoreRoute(
        new NextRequest("http://localhost/api/backup/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
    expect(res.status).toBe(200);
    const restored = await prisma.firearm.findUnique({ where: { id: "restored-1" } });
    // Proves the date migration really ran inside the request (and so really was suppressed).
    expect(restored!.acquisitionDate.getTime() % 86_400_000).toBe(0);
    const events = await newEventsSince(before);
    // Exactly one RESTORE event (Task 5) — no per-row entries from the replace or the
    // post-restore date migration, both of which ran under withoutRowAudit.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "RESTORE", actorName: "system" });
    expect(JSON.parse(events[0].changes ?? "null")).toMatchObject({ counts: { firearms: 1 } });
  }, 30_000);

  // ─── Security events (Task 5) ──────────────────────────────────

  it("login: success writes one LOGIN event naming the user; a wrong password and an unknown username each write LOGIN_FAILED with no actor", async () => {
    const pw = "correct horse battery staple";
    const passwordHash = await hashPassword(pw);
    const bob = await prisma.user.create({
      data: { username: "bob-login", displayName: "Bob Login", passwordHash, role: "USER" },
    });

    req.current = new Headers();
    const ok = await eventsFrom(() =>
      loginRoute(
        new NextRequest("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "bob-login", password: pw }),
        }),
      ),
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({
      action: "LOGIN",
      entityType: "User",
      entityId: bob.id,
      actorId: bob.id,
      actorName: "Bob Login (@bob-login)",
    });

    req.current = new Headers();
    const wrong = await eventsFrom(() =>
      loginRoute(
        new NextRequest("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "bob-login", password: "not the password" }),
        }),
      ),
    );
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatchObject({ action: "LOGIN_FAILED", actorId: null, actorName: "anonymous" });
    expect(changesOf(wrong[0])).toEqual({ username: "bob-login" });

    req.current = new Headers();
    const unknown = await eventsFrom(() =>
      loginRoute(
        new NextRequest("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "nobody-at-all", password: pw }),
        }),
      ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ action: "LOGIN_FAILED", actorId: null, actorName: "anonymous" });
    expect(changesOf(unknown[0])).toEqual({ username: "nobody-at-all" });
  }, 20_000);

  it("login: a request that already carries a valid session for another account still records LOGIN_FAILED as anonymous, not that account (fix round 1, Important #2)", async () => {
    const other = await prisma.user.create({
      data: { username: "other-signed-in", displayName: "Other Signed In", passwordHash: "x", role: "USER" },
    });
    req.current = new Headers();
    // A signed-in request (getCurrentUser() would resolve this account) POSTing bad
    // credentials for a DIFFERENT username must not attribute the failure to it.
    req.user = { id: other.id, username: "other-signed-in", displayName: "Other Signed In", role: "USER", sessionId: "s" };
    const events = await eventsFrom(() =>
      loginRoute(
        new NextRequest("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "bv_session=some-valid-looking-token" },
          body: JSON.stringify({ username: "some-other-user", password: "wrong password here" }),
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "LOGIN_FAILED", actorId: null, actorName: "anonymous" });
    expect(changesOf(events[0])).toEqual({ username: "some-other-user" });
  }, 20_000);

  it("role change: one ROLE_CHANGED attributed to the acting admin; refused (last admin) rolls it back", async () => {
    const admin1 = await prisma.user.create({
      data: { username: "admin-one", displayName: "Admin One", passwordHash: "x", role: "ADMIN" },
    });
    const target = await prisma.user.create({
      data: { username: "target-one", displayName: "Target One", passwordHash: "x", role: "USER" },
    });

    req.current = new Headers();
    req.user = { id: admin1.id, username: "admin-one", displayName: "Admin One", role: "ADMIN", sessionId: "s" };

    const events = await eventsFrom(() => changeRoleOrStatus(target.id, { role: "ADMIN" }, admin1.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "ROLE_CHANGED",
      entityType: "User",
      entityId: target.id,
      actorId: admin1.id,
      actorName: "Admin One (@admin-one)",
    });
    expect(changesOf(events[0])).toEqual({ from: "USER", to: "ADMIN" });

    // Last-admin refusal: demoting the sole active admin rolls the update AND the
    // audit row back together (Review Focus #1, applied to a security event).
    await prisma.user.updateMany({ where: { role: "ADMIN" }, data: { disabledAt: new Date() } });
    await prisma.user.update({ where: { id: admin1.id }, data: { disabledAt: null } });
    const before = await eventIds();
    const result = await within(5_000, changeRoleOrStatus(admin1.id, { role: "USER" }, admin1.id));
    expect(result).toEqual({ ok: false, status: 409, error: "At least one active admin is required" });
    expect(await newEventsSince(before)).toEqual([]);
    expect((await prisma.user.findUnique({ where: { id: admin1.id } }))!.role).toBe("ADMIN");
  }, 20_000);
});
