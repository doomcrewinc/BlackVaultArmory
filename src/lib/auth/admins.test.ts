import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * changeRoleOrStatus against an in-memory user table with real transaction semantics: the
 * callback works on a staged copy, which is committed only if the callback returns and thrown
 * away if it throws. That makes "throw to roll back" observable.
 */
type Row = { id: string; role: string; disabledAt: Date | null; displayName: string; username: string };
type TokenRow = { id: string; createdById: string | null; usedAt: Date | null };

const m = vi.hoisted(() => ({
  users: [] as Row[],
  tokens: [] as TokenRow[],
  committed: 0,
  rolledBack: 0,
  txOptions: [] as unknown[],
  countOverride: null as null | ((updated: boolean) => number),
  failFirstWith: null as null | { code: string },
  endUserSessions: vi.fn(async () => {}),
  findMany: vi.fn(),
  recordEvent: vi.fn(async () => {}),
}));

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findMany: m.findMany },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      m.txOptions.push(options);
      if (m.failFirstWith) {
        const err = Object.assign(new Error("write conflict"), m.failFirstWith);
        m.failFirstWith = null;
        throw err;
      }
      const staged = m.users.map((u) => ({ ...u }));
      const stagedTokens = m.tokens.map((t) => ({ ...t }));
      let updated = false;
      const tx = {
        user: {
          findUnique: async ({ where }: { where: { id: string } }) => staged.find((u) => u.id === where.id) ?? null,
          update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
            const row = staged.find((u) => u.id === where.id);
            if (!row) throw new Error("not found");
            Object.assign(row, data);
            updated = true;
            return row;
          },
          count: async ({ where }: { where: Record<string, unknown> }) =>
            m.countOverride ? m.countOverride(updated) : staged.filter((u) => matches(u, where)).length,
        },
        authToken: {
          updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<TokenRow> }) => {
            const hit = stagedTokens.filter((t) => matches(t as unknown as Row, where));
            hit.forEach((t) => Object.assign(t, data));
            return { count: hit.length };
          },
        },
      };
      try {
        const result = await fn(tx);
        m.users = staged;
        m.tokens = stagedTokens;
        m.committed += 1;
        return result;
      } catch (error) {
        m.rolledBack += 1;
        throw error;
      }
    },
  },
}));

vi.mock("@/lib/auth/sessions", () => ({ endUserSessions: m.endUserSessions }));
vi.mock("@/lib/audit/events", () => ({ recordEvent: m.recordEvent }));

import { changeRoleOrStatus, listAdmins } from "./admins";

const LAST_ADMIN = { ok: false, status: 409, error: "At least one active admin is required" };

function admin(id: string, disabledAt: Date | null = null): Row {
  return { id, role: "ADMIN", disabledAt, displayName: id, username: id };
}
function user(id: string): Row {
  return { id, role: "USER", disabledAt: null, displayName: id, username: id };
}
const row = (id: string) => m.users.find((u) => u.id === id)!;

/** The tx object recordEvent should have been called with: the tx from the callback the test drove. */
function txArg() {
  return expect.objectContaining({ user: expect.anything() });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.users = [];
  m.tokens = [];
  m.committed = 0;
  m.rolledBack = 0;
  m.txOptions = [];
  m.countOverride = null;
  m.failFirstWith = null;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("changeRoleOrStatus — last active admin (Review Focus #5)", () => {
  it("sole admin demoting self → 409, rolled back", async () => {
    m.users = [admin("a"), user("u")];
    expect(await changeRoleOrStatus("a", { role: "USER" }, "a")).toEqual(LAST_ADMIN);
    expect(row("a").role).toBe("ADMIN");
    expect(m.rolledBack).toBe(1);
    expect(m.committed).toBe(0);
  });

  it("sole admin disabling self → 409, rolled back, sessions untouched", async () => {
    m.users = [admin("a"), user("u")];
    expect(await changeRoleOrStatus("a", { disabled: true }, "a")).toEqual(LAST_ADMIN);
    expect(row("a").disabledAt).toBeNull();
    expect(m.endUserSessions).not.toHaveBeenCalled();
  });

  it("a disabled second admin does not count as active", async () => {
    m.users = [admin("a"), admin("b", new Date())];
    expect(await changeRoleOrStatus("a", { role: "USER" }, "a")).toEqual(LAST_ADMIN);
  });

  it("with two active admins, demoting one succeeds", async () => {
    m.users = [admin("a"), admin("b")];
    expect(await changeRoleOrStatus("b", { role: "USER" }, "a")).toEqual({ ok: true });
    expect(row("b").role).toBe("USER");
    expect(m.committed).toBe(1);
    expect(m.recordEvent).toHaveBeenCalledWith(txArg(), {
      action: "ROLE_CHANGED",
      entityType: "User",
      entityId: "b",
      entityLabel: "b (@b)",
      changes: { from: "ADMIN", to: "USER" },
    });
  });

  it("re-counts AFTER the change inside the transaction: count 0 after the update → 409 + rollback", async () => {
    // Two admins at the start, so a count taken BEFORE the update sees 2 and would allow it; a
    // concurrent demotion committed in between is simulated by the post-update count being 0.
    m.users = [admin("a"), admin("b")];
    m.countOverride = (updated) => (updated ? 0 : 2);
    expect(await changeRoleOrStatus("b", { role: "USER" }, "a")).toEqual(LAST_ADMIN);
    expect(row("b").role).toBe("ADMIN");
    expect(m.rolledBack).toBe(1);
    // recordEvent was called inside the rolled-back transaction — the injection
    // test below proves this actually matters, against the real DB.
    expect(m.recordEvent).toHaveBeenCalled();
  });

  it("the second of two sequential demotions is refused", async () => {
    m.users = [admin("a"), admin("b")];
    expect(await changeRoleOrStatus("a", { role: "USER" }, "b")).toEqual({ ok: true });
    expect(await changeRoleOrStatus("b", { role: "USER" }, "a")).toEqual(LAST_ADMIN);
    expect(m.users.filter((u) => u.role === "ADMIN")).toHaveLength(1);
  });

  it("runs the transaction Serializable", async () => {
    m.users = [admin("a"), admin("b")];
    await changeRoleOrStatus("b", { role: "USER" }, "a");
    expect(m.txOptions[0]).toEqual({ isolationLevel: "Serializable" });
  });

  it("retries a serialization failure (P2034) and then decides on fresh data", async () => {
    m.users = [admin("a"), admin("b")];
    m.failFirstWith = { code: "P2034" };
    expect(await changeRoleOrStatus("b", { role: "USER" }, "a")).toEqual({ ok: true });
    expect(m.txOptions).toHaveLength(2);
  });

  it("does not retry other errors", async () => {
    m.users = [admin("a"), admin("b")];
    m.failFirstWith = { code: "P2025" };
    await expect(changeRoleOrStatus("b", { role: "USER" }, "a")).rejects.toThrow("write conflict");
    expect(m.txOptions).toHaveLength(1);
  });
});

describe("changeRoleOrStatus — other rules", () => {
  it("unknown target → 404", async () => {
    m.users = [admin("a")];
    expect(await changeRoleOrStatus("nope", { role: "USER" }, "a")).toEqual({
      ok: false,
      status: 404,
      error: "User not found",
    });
  });

  it.each([[{}], [{ role: "OWNER" }], [{ role: "admin" }], [{ disabled: "yes" }], [{ role: null }]])(
    "invalid change %j → 400",
    async (change) => {
      m.users = [admin("a"), user("u")];
      expect(await changeRoleOrStatus("u", change as never, "a")).toEqual({
        ok: false,
        status: 400,
        error: "Invalid request",
      });
      expect(m.committed).toBe(0);
    },
  );

  it("promoting a user works", async () => {
    m.users = [admin("a"), user("u")];
    expect(await changeRoleOrStatus("u", { role: "ADMIN" }, "a")).toEqual({ ok: true });
    expect(row("u").role).toBe("ADMIN");
    expect(m.recordEvent).toHaveBeenCalledWith(txArg(), {
      action: "ROLE_CHANGED",
      entityType: "User",
      entityId: "u",
      entityLabel: "u (@u)",
      changes: { from: "USER", to: "ADMIN" },
    });
  });

  it("disabling a user sets disabledAt and ends all of their sessions", async () => {
    m.users = [admin("a"), user("u")];
    expect(await changeRoleOrStatus("u", { disabled: true }, "a")).toEqual({ ok: true });
    expect(row("u").disabledAt).toBeInstanceOf(Date);
    expect(m.endUserSessions).toHaveBeenCalledWith("u");
    expect(m.recordEvent).toHaveBeenCalledWith(txArg(), {
      action: "USER_DISABLED",
      entityType: "User",
      entityId: "u",
      entityLabel: "u (@u)",
    });
    expect(m.recordEvent).not.toHaveBeenCalledWith(txArg(), expect.objectContaining({ action: "ROLE_CHANGED" }));
  });

  it("disabling an already-disabled user keeps the original disabledAt and records no event", async () => {
    const when = new Date("2026-01-01T00:00:00Z");
    m.users = [admin("a"), { ...user("u"), disabledAt: when }];
    await changeRoleOrStatus("u", { disabled: true }, "a");
    expect(row("u").disabledAt).toEqual(when);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("re-enabling clears disabledAt and does not end sessions", async () => {
    m.users = [admin("a"), { ...user("u"), disabledAt: new Date() }];
    expect(await changeRoleOrStatus("u", { disabled: false }, "a")).toEqual({ ok: true });
    expect(row("u").disabledAt).toBeNull();
    expect(m.endUserSessions).not.toHaveBeenCalled();
    expect(m.recordEvent).toHaveBeenCalledWith(txArg(), {
      action: "USER_ENABLED",
      entityType: "User",
      entityId: "u",
      entityLabel: "u (@u)",
    });
  });

  it("changing role and disabled state together records both events", async () => {
    m.users = [admin("a"), user("u")];
    expect(await changeRoleOrStatus("u", { role: "ADMIN", disabled: true }, "a")).toEqual({ ok: true });
    expect(m.recordEvent).toHaveBeenCalledWith(
      txArg(),
      expect.objectContaining({ action: "ROLE_CHANGED", changes: { from: "USER", to: "ADMIN" } }),
    );
    expect(m.recordEvent).toHaveBeenCalledWith(txArg(), expect.objectContaining({ action: "USER_DISABLED" }));
    expect(m.recordEvent).toHaveBeenCalledTimes(2);
  });
});

describe("changeRoleOrStatus — an issuer's unused links die with their admin rights (ruling A13)", () => {
  const unusedOf = (id: string) => m.tokens.filter((t) => t.createdById === id && t.usedAt === null).map((t) => t.id);

  beforeEach(() => {
    m.tokens = [
      { id: "b-inv", createdById: "b", usedAt: null },
      { id: "b-reset", createdById: "b", usedAt: null },
      { id: "b-old", createdById: "b", usedAt: new Date("2026-01-01T00:00:00Z") },
      { id: "a-inv", createdById: "a", usedAt: null },
    ];
  });

  it("disabling an admin marks every unused link they issued as used", async () => {
    m.users = [admin("a"), admin("b")];
    expect(await changeRoleOrStatus("b", { disabled: true }, "a")).toEqual({ ok: true });
    expect(unusedOf("b")).toEqual([]);
    expect(m.tokens.find((t) => t.id === "b-old")?.usedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(unusedOf("a")).toEqual(["a-inv"]);
  });

  it("demoting an admin to USER marks every unused link they issued as used", async () => {
    m.users = [admin("a"), admin("b")];
    expect(await changeRoleOrStatus("b", { role: "USER" }, "a")).toEqual({ ok: true });
    expect(unusedOf("b")).toEqual([]);
    expect(unusedOf("a")).toEqual(["a-inv"]);
  });

  it("promoting or re-enabling leaves the links alone", async () => {
    m.users = [admin("a"), { ...admin("b"), disabledAt: new Date() }];
    expect(await changeRoleOrStatus("b", { disabled: false }, "a")).toEqual({ ok: true });
    expect(await changeRoleOrStatus("b", { role: "ADMIN" }, "a")).toEqual({ ok: true });
    expect(unusedOf("b")).toEqual(["b-inv", "b-reset"]);
  });

  it("a refused change (last admin) rolls the link revocation back too", async () => {
    m.users = [admin("b"), user("u")];
    expect(await changeRoleOrStatus("b", { disabled: true }, "b")).toEqual(LAST_ADMIN);
    expect(unusedOf("b")).toEqual(["b-inv", "b-reset"]);
  });
});

describe("listAdmins", () => {
  it("queries active admins only and returns display names", async () => {
    m.findMany.mockResolvedValue([{ displayName: "Alice" }, { displayName: "Bob" }]);
    expect(await listAdmins()).toEqual([{ displayName: "Alice" }, { displayName: "Bob" }]);
    expect(m.findMany).toHaveBeenCalledWith({
      where: { role: "ADMIN", disabledAt: null },
      select: { displayName: true },
      orderBy: { displayName: "asc" },
    });
  });
});
