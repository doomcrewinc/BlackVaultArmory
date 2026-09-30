import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../prisma", () => ({ prisma: { auditEvent: { findMany: m.findMany } } }));

vi.mock("../db/text-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/text-search")>();
  return { ...actual, containsInsensitive: vi.fn(actual.containsInsensitive) };
});

import { containsInsensitive } from "../db/text-search";
import { AUDIT_ACTIONS } from "./actions";
import { ACTION_GROUPS, hasNulByte, listAuditEvents, parseAuditFilters } from "./query";

type RawRow = {
  id: string;
  at: Date;
  actorId: string | null;
  actorName: string;
  actorIp: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  changes: string | null;
};

function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: "e1",
    at: new Date("2026-03-05T00:00:00.000Z"),
    actorId: null,
    actorName: "system",
    actorIp: null,
    action: "CREATE",
    entityType: null,
    entityId: null,
    entityLabel: null,
    changes: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.findMany.mockResolvedValue([]);
});

describe("parseAuditFilters", () => {
  it("returns {} for empty search params", () => {
    expect(parseAuditFilters(new URLSearchParams())).toEqual({});
  });

  it("keeps user, type, q trimmed", () => {
    const sp = new URLSearchParams({ user: " u1 ", type: " Firearm ", q: " glock " });
    expect(parseAuditFilters(sp)).toEqual({ user: "u1", type: "Firearm", q: "glock" });
  });

  it("drops empty/whitespace-only user, type, q", () => {
    const sp = new URLSearchParams({ user: "   ", type: "", q: "   " });
    expect(parseAuditFilters(sp)).toEqual({});
  });

  it.each(["creates", "edits", "deletes", "signins", "security"] as const)("keeps a valid action group: %s", (group) => {
    expect(parseAuditFilters(new URLSearchParams({ action: group }))).toEqual({ action: group });
  });

  it("drops an unrecognised action group", () => {
    expect(parseAuditFilters(new URLSearchParams({ action: "bogus" }))).toEqual({});
  });

  it("parses from as the inclusive UTC day start", () => {
    const filters = parseAuditFilters(new URLSearchParams({ from: "2026-03-05" }));
    expect(filters.from?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  it("parses to as the inclusive UTC day end (23:59:59.999)", () => {
    const filters = parseAuditFilters(new URLSearchParams({ to: "2026-03-05" }));
    expect(filters.to?.toISOString()).toBe("2026-03-05T23:59:59.999Z");
  });

  it("drops malformed from/to instead of throwing", () => {
    expect(() => parseAuditFilters(new URLSearchParams({ from: "not-a-date", to: "also-bad" }))).not.toThrow();
    expect(parseAuditFilters(new URLSearchParams({ from: "not-a-date", to: "also-bad" }))).toEqual({});
  });

  // Fix round 1, Important: out-of-range/invalid dates must be dropped, not
  // handed to Prisma, which throws (500) rather than returning zero rows.
  it.each(["2026-02-31", "0000-00-00", "2026-09-29junk", "9999-99-99"])(
    "drops the calendar-invalid/out-of-range date %j for from and to",
    (raw) => {
      expect(parseAuditFilters(new URLSearchParams({ from: raw }))).toEqual({});
      expect(parseAuditFilters(new URLSearchParams({ to: raw }))).toEqual({});
    },
  );

  it("accepts the year boundaries 1970 and 9999", () => {
    expect(parseAuditFilters(new URLSearchParams({ from: "1970-01-01" })).from?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(parseAuditFilters(new URLSearchParams({ from: "9999-12-31" })).from?.toISOString()).toBe("9999-12-31T00:00:00.000Z");
  });

  it("drops a year just outside 1970-9999", () => {
    expect(parseAuditFilters(new URLSearchParams({ from: "1969-12-31" }))).toEqual({});
  });

  it("keeps a well-formed cursor", () => {
    const cursor = "2026-03-05T00:00:00.000Z_abc123";
    expect(parseAuditFilters(new URLSearchParams({ cursor }))).toEqual({ cursor });
  });

  it("drops a malformed cursor instead of throwing", () => {
    expect(parseAuditFilters(new URLSearchParams({ cursor: "not-a-date_abc" }))).toEqual({});
    expect(parseAuditFilters(new URLSearchParams({ cursor: "2026-03-05T00:00:00.000Z_" }))).toEqual({});
    expect(parseAuditFilters(new URLSearchParams({ cursor: "no-separator-here" }))).toEqual({});
  });

  // Fix round 1, Important, reviewer's exact inputs: `new Date()` accepts
  // extended-year ISO strings, which used to pass the old isNaN-only check
  // and then make Prisma throw (500) on both providers.
  it.each(["+275760-09-13T00:00:00.000Z_x", "-271821-04-20T00:00:00.000Z_x"])(
    "drops the extended-year cursor %j instead of letting it reach Prisma",
    (cursor) => {
      expect(parseAuditFilters(new URLSearchParams({ cursor }))).toEqual({});
    },
  );

  it("drops a cursor whose calendar part is invalid or carries trailing junk", () => {
    expect(parseAuditFilters(new URLSearchParams({ cursor: "2026-02-31T00:00:00.000Z_x" }))).toEqual({});
    expect(parseAuditFilters(new URLSearchParams({ cursor: "2026-09-29T00:00:00.000Zjunk_x" }))).toEqual({});
  });

  // Fix round 1, Minor: a NUL byte in user/type/q reaches Postgres as-is and
  // errors 22021 (invalid byte sequence for UTF8) — a 500, not zero rows.
  it("drops a NUL byte in user, type, or q instead of throwing", () => {
    expect(parseAuditFilters(new URLSearchParams({ user: "\u0000" }))).toEqual({});
    expect(parseAuditFilters(new URLSearchParams({ type: "\u0000" }))).toEqual({});
    expect(parseAuditFilters(new URLSearchParams({ q: "\u0000" }))).toEqual({});
    expect(parseAuditFilters(new URLSearchParams({ user: "u\u00001" }))).toEqual({});
  });

  it("drops a cursor whose id carries a NUL byte", () => {
    expect(parseAuditFilters(new URLSearchParams({ cursor: "2026-03-05T00:00:00.000Z_ab\u0000c" }))).toEqual({});
  });

  it("combines every filter at once", () => {
    const sp = new URLSearchParams({
      user: "u1",
      action: "edits",
      type: "Firearm",
      from: "2026-03-01",
      to: "2026-03-31",
      q: "glock",
      cursor: "2026-03-05T00:00:00.000Z_abc",
    });
    const filters = parseAuditFilters(sp);
    expect(filters.user).toBe("u1");
    expect(filters.action).toBe("edits");
    expect(filters.type).toBe("Firearm");
    expect(filters.from?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(filters.to?.toISOString()).toBe("2026-03-31T23:59:59.999Z");
    expect(filters.q).toBe("glock");
    expect(filters.cursor).toBe("2026-03-05T00:00:00.000Z_abc");
  });
});

describe("hasNulByte", () => {
  it("is true only when the string contains a NUL byte, wherever it sits", () => {
    expect(hasNulByte("\u0000")).toBe(true);
    expect(hasNulByte("ab\u0000cd")).toBe(true);
    expect(hasNulByte("\u0000ab")).toBe(true);
    expect(hasNulByte("ab\u0000")).toBe(true);
    expect(hasNulByte("")).toBe(false);
    expect(hasNulByte("plain")).toBe(false);
  });
});

describe("ACTION_GROUPS", () => {
  it("maps each group to exactly the actions the brief specifies", () => {
    expect(ACTION_GROUPS.creates).toEqual(["CREATE"]);
    expect(ACTION_GROUPS.edits).toEqual(["UPDATE"]);
    expect(ACTION_GROUPS.deletes).toEqual(["DELETE"]);
    expect(ACTION_GROUPS.signins).toEqual(["LOGIN", "LOGIN_FAILED", "LOGOUT"]);
    expect(ACTION_GROUPS.security).toEqual([
      "INVITE_CREATED",
      "INVITE_REDEEMED",
      "ROLE_CHANGED",
      "USER_DISABLED",
      "USER_ENABLED",
      "RESET_LINK_ISSUED",
      "PASSWORD_CHANGED",
      "DIRECT_ACCESS_CHANGED",
      "BACKUP_CREATED",
      "RESTORE",
    ]);
  });

  it("covers every AUDIT_ACTIONS entry exactly once (a new action can't silently fall out of every group)", () => {
    const all = Object.values(ACTION_GROUPS).flat();
    expect([...all].sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("listAuditEvents", () => {
  it("orders by at desc, id desc and requests limit+1 rows", async () => {
    await listAuditEvents({}, 10);
    expect(m.findMany).toHaveBeenCalledWith({ where: {}, orderBy: [{ at: "desc" }, { id: "desc" }], take: 11 });
  });

  it("defaults limit to 50", async () => {
    await listAuditEvents({});
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
  });

  it("filters user on actorId", async () => {
    await listAuditEvents({ user: "u1" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ actorId: "u1" }] });
  });

  it("filters action group on the group's mapped action list", async () => {
    await listAuditEvents({ action: "edits" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ action: { in: ["UPDATE"] } }] });
  });

  it("filters type on entityType", async () => {
    await listAuditEvents({ type: "Firearm" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ entityType: "Firearm" }] });
  });

  it("filters entityId on entityId (item-history composition)", async () => {
    await listAuditEvents({ entityId: "f1" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ entityId: "f1" }] });
  });

  it("q filters entityLabel via containsInsensitive, case-insensitively on both providers", async () => {
    await listAuditEvents({ q: "Glock" });
    expect(containsInsensitive).toHaveBeenCalledWith("Glock");
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ entityLabel: containsInsensitive("Glock") }] });
  });

  it("from/to build an inclusive at range", async () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-03-31T23:59:59.999Z");
    await listAuditEvents({ from, to });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ at: { gte: from, lte: to } }] });
  });

  it("from alone omits lte; to alone omits gte", async () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    await listAuditEvents({ from });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ at: { gte: from } }] });

    m.findMany.mockClear();
    const to = new Date("2026-03-31T23:59:59.999Z");
    await listAuditEvents({ to });
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ at: { lte: to } }] });
  });

  it("combines every filter with AND", async () => {
    await listAuditEvents({ user: "u1", type: "Firearm", q: "glock" });
    expect(m.findMany.mock.calls[0][0].where.AND).toHaveLength(3);
  });

  it("a well-formed cursor adds an OR tie-break on (at, id)", async () => {
    await listAuditEvents({ cursor: "2026-03-05T00:00:00.000Z_abc" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({
      AND: [
        {
          OR: [
            { at: { lt: new Date("2026-03-05T00:00:00.000Z") } },
            { at: new Date("2026-03-05T00:00:00.000Z"), id: { lt: "abc" } },
          ],
        },
      ],
    });
  });

  it("a malformed cursor is silently ignored (no OR clause, no throw)", async () => {
    await expect(listAuditEvents({ cursor: "garbage" })).resolves.toBeDefined();
    expect(m.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("an extended-year cursor (reviewer's exact inputs) is silently ignored, not passed to Prisma", async () => {
    await listAuditEvents({ cursor: "+275760-09-13T00:00:00.000Z_x" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({});

    m.findMany.mockClear();
    await listAuditEvents({ cursor: "-271821-04-20T00:00:00.000Z_x" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("a cursor whose id carries a NUL byte is silently ignored, not passed to Prisma", async () => {
    await listAuditEvents({ cursor: "2026-03-05T00:00:00.000Z_ab\u0000c" });
    expect(m.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("maps rows to DTOs: at as an ISO string, changes parsed from JSON", async () => {
    m.findMany.mockResolvedValue([
      row({
        id: "e1",
        at: new Date("2026-03-05T00:00:00.000Z"),
        actorId: "u1",
        actorName: "Alice A (@alice)",
        actorIp: "10.0.0.1",
        action: "UPDATE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: "Glock 19 (9mm)",
        changes: '{"name":["a","b"]}',
      }),
    ]);
    const { events } = await listAuditEvents({});
    expect(events).toEqual([
      {
        id: "e1",
        at: "2026-03-05T00:00:00.000Z",
        actorId: "u1",
        actorName: "Alice A (@alice)",
        actorIp: "10.0.0.1",
        action: "UPDATE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: "Glock 19 (9mm)",
        changes: { name: ["a", "b"] },
      },
    ]);
  });

  it("changes is null when missing", async () => {
    m.findMany.mockResolvedValue([row({ changes: null })]);
    const { events } = await listAuditEvents({});
    expect(events[0].changes).toBeNull();
  });

  it("changes is null when it doesn't parse, rather than throwing", async () => {
    m.findMany.mockResolvedValue([row({ changes: "not json" })]);
    const { events } = await listAuditEvents({});
    expect(events[0].changes).toBeNull();
  });

  it("nextCursor is null when the store has no more rows", async () => {
    m.findMany.mockResolvedValue([row({ id: "e1" })]);
    const { nextCursor } = await listAuditEvents({}, 50);
    expect(nextCursor).toBeNull();
  });

  it("nextCursor is the (at, id) of the last row of the trimmed page when another page follows", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row({ id: `e${i}`, at: new Date(`2026-01-0${i + 1}T00:00:00.000Z`) }));
    m.findMany.mockResolvedValue(rows);
    const { events, nextCursor } = await listAuditEvents({}, 2);
    expect(events).toHaveLength(2);
    expect(nextCursor).toBe(`${rows[1].at.toISOString()}_${rows[1].id}`);
  });
});
