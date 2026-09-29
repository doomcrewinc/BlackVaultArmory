import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashToken } from "@/lib/auth/tokens";

type TokenRow = {
  kind: string;
  role: string | null;
  userId: string | null;
  createdById?: string | null;
  usedAt: Date | null;
  expiresAt: Date | null;
};
type UserRow = { id: string; username: string; displayName: string; role: string; passwordHash: string; disabledAt?: Date | null };
type TokenWhere = { tokenHash: string; kind: string; createdBy?: { is: { role: string; disabledAt: null } } };

/**
 * In-memory tables with a $transaction that ROLLS BACK on throw, like the real one — so
 * "duplicate username → 409 and the invite is still unused" is observed through state.
 * (redeem.real-db.test.ts proves the same against real SQLite.)
 */
const m = vi.hoisted(() => {
  const tokens = new Map<string, TokenRow>();
  const users = new Map<string, UserRow>();
  const clone = <T,>(map: Map<string, T>) => new Map([...map].map(([k, v]) => [k, { ...v }]));
  const db = {
    authToken: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const row = tokens.get(where.tokenHash);
        if (!row) return null;
        const issuer = row.createdById ? users.get(row.createdById) : undefined;
        return { ...row, createdBy: issuer ? { role: issuer.role, disabledAt: issuer.disabledAt ?? null } : null };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: TokenWhere; data: { usedAt: Date } }) => {
        const row = tokens.get(where.tokenHash);
        if (!row || row.kind !== where.kind || row.usedAt || (row.expiresAt && row.expiresAt <= data.usedAt)) return { count: 0 };
        if (where.createdBy) {
          // Relation filter `createdBy: { is: { role, disabledAt: null } }`, as Prisma evaluates it.
          const issuer = row.createdById ? users.get(row.createdById) : undefined;
          const want = where.createdBy.is;
          if (!issuer || issuer.role !== want.role || (issuer.disabledAt ?? null) !== want.disabledAt) return { count: 0 };
        }
        row.usedAt = data.usedAt;
        return { count: 1 };
      }),
    },
    user: {
      create: vi.fn(async ({ data }: { data: Omit<UserRow, "id"> }) => {
        if ([...users.values()].some((u) => u.username === data.username)) {
          // Shape of PrismaClientKnownRequestError for a unique violation.
          throw Object.assign(new Error("Unique constraint failed on the fields: (`username`)"), { code: "P2002" });
        }
        const user = { id: `id-${data.username}`, ...data };
        users.set(user.id, user);
        return user;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const user = users.get(where.id);
        if (!user) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(user, data);
        return user;
      }),
    },
    session: {
      create: vi.fn<(args: { data: { userId: string } }) => Promise<object>>(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => {
    const [t, u] = [clone(tokens), clone(users)];
    try {
      return await fn(db);
    } catch (error) {
      tokens.clear();
      t.forEach((v, k) => tokens.set(k, v));
      users.clear();
      u.forEach((v, k) => users.set(k, v));
      throw error;
    }
  });
  return { tokens, users, db };
});

vi.mock("@/lib/prisma", () => ({ prisma: m.db }));
vi.mock("@/lib/auth/password", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/password")>("@/lib/auth/password");
  return { ...actual, hashPassword: vi.fn(async (pw: string) => `h(${pw})`) };
});

import { POST } from "./route";

const PW = "correct horse battery";
const FUTURE = new Date(Date.now() + 86_400_000);
const GONE = { error: "Link expired or already used" };

function req(body: unknown, cookie?: string) {
  return new NextRequest("http://localhost/api/auth/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const tokenRow = (raw: string) => m.tokens.get(hashToken(raw));

beforeEach(() => {
  vi.clearAllMocks();
  m.tokens.clear();
  m.users.clear();
  m.users.set("boss1", { id: "boss1", username: "boss1", displayName: "Boss", role: "ADMIN", passwordHash: "x", disabledAt: null });
  const invite = { kind: "INVITE", userId: null, createdById: "boss1", usedAt: null, expiresAt: FUTURE };
  m.tokens.set(hashToken("inv-user"), { ...invite, role: "USER" });
  m.tokens.set(hashToken("inv-admin"), { ...invite, role: "ADMIN" });
  m.tokens.set(hashToken("reset-u1"), { kind: "RESET", role: null, userId: "u1", usedAt: null, expiresAt: FUTURE });
  m.tokens.set(hashToken("used"), { kind: "INVITE", role: "USER", userId: null, usedAt: new Date(), expiresAt: FUTURE });
  m.tokens.set(hashToken("SETUPCODE"), { kind: "SETUP", role: null, userId: null, usedAt: null, expiresAt: null });
  m.users.set("u1", { id: "u1", username: "jeff", displayName: "Jeff", role: "USER", passwordHash: "h(old password here)" });
});

describe("POST /api/auth/redeem — invite", () => {
  it("creates a USER with the lowercase username, signs them in, and uses the token", async () => {
    const res = await POST(req({ token: "inv-user", username: " NewGuy ", displayName: " New Guy ", password: PW }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/" });
    const created = m.users.get("id-newguy");
    expect(created).toMatchObject({ username: "newguy", displayName: "New Guy", role: "USER", passwordHash: `h(${PW})` });
    expect(tokenRow("inv-user")?.usedAt).toBeInstanceOf(Date);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bv_session=");
    expect(cookie).toContain("HttpOnly");
    expect(m.db.session.create.mock.calls[0][0].data.userId).toBe("id-newguy");
  });

  it("grants the role chosen on the invite", async () => {
    const res = await POST(req({ token: "inv-admin", username: "boss", displayName: "Boss", password: PW }));
    expect(res.status).toBe(200);
    expect(m.users.get("id-boss")?.role).toBe("ADMIN");
  });

  it("409 Username taken for a case/space variant of an existing name — the invite stays unused and can be retried", async () => {
    const dup = await POST(req({ token: "inv-user", username: " JEFF ", displayName: "Other", password: PW }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "Username taken" });
    expect(tokenRow("inv-user")?.usedAt).toBeNull();
    expect(dup.headers.get("set-cookie")).toBeNull();

    const retry = await POST(req({ token: "inv-user", username: "jeff2", displayName: "Other", password: PW }));
    expect(retry.status).toBe(200);
    expect(m.users.get("id-jeff2")).toBeDefined();
  });

  it("400 on validation errors without consuming the invite", async () => {
    for (const bad of [
      { username: "a b", displayName: "X", password: PW },
      { username: "ok-name", displayName: "  ", password: PW },
      { username: "ok-name", displayName: "X", password: "short" },
      { displayName: "X", password: PW },
    ]) {
      const res = await POST(req({ token: "inv-user", ...bad }));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(tokenRow("inv-user")?.usedAt).toBeNull();
  });
});

describe("POST /api/auth/redeem — the issuer must still be an active admin (ruling A13)", () => {
  it.each([
    ["disabled", { disabledAt: new Date() }],
    ["demoted to USER", { role: "USER" }],
  ])("404 when the issuer was %s — no account, invite not consumed", async (_label, change) => {
    Object.assign(m.users.get("boss1")!, change);
    const res = await POST(req({ token: "inv-admin", username: "jeff-again", displayName: "J", password: PW }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GONE);
    expect(m.users.get("id-jeff-again")).toBeUndefined();
    expect(tokenRow("inv-admin")?.usedAt).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("404 when the invite has no issuer at all", async () => {
    tokenRow("inv-user")!.createdById = null;
    const res = await POST(req({ token: "inv-user", username: "orphan", displayName: "O", password: PW }));
    expect(res.status).toBe(404);
    expect(m.users.get("id-orphan")).toBeUndefined();
  });

  it("404 when the issuer is disabled between the peek and the transaction", async () => {
    // Peek sees an active issuer; the transaction's own check is the one that must hold.
    const peekFind = m.db.authToken.findUnique.getMockImplementation()!;
    m.db.authToken.findUnique.mockImplementationOnce(async (args) => {
      const peeked = await peekFind(args);
      m.users.get("boss1")!.disabledAt = new Date();
      return peeked;
    });
    const res = await POST(req({ token: "inv-user", username: "racer2", displayName: "R", password: PW }));
    expect(res.status).toBe(404);
    expect(m.users.get("id-racer2")).toBeUndefined();
  });
});

describe("POST /api/auth/redeem — reset", () => {
  it("sets the new hash, deletes all the user's sessions, and signs them in", async () => {
    const res = await POST(req({ token: "reset-u1", password: PW }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/" });
    expect(m.users.get("u1")?.passwordHash).toBe(`h(${PW})`);
    expect(m.db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(tokenRow("reset-u1")?.usedAt).toBeInstanceOf(Date);
    expect(res.headers.get("set-cookie") ?? "").toContain("bv_session=");
    // The new session is created AFTER the wipe, so it survives.
    const wipeOrder = m.db.session.deleteMany.mock.invocationCallOrder.at(-1)!;
    expect(m.db.session.create.mock.invocationCallOrder[0]).toBeGreaterThan(wipeOrder);
  });

  it("400 for a too-short password, without consuming the link", async () => {
    const res = await POST(req({ token: "reset-u1", password: "short" }));
    expect(res.status).toBe(400);
    expect(tokenRow("reset-u1")?.usedAt).toBeNull();
    expect(m.users.get("u1")?.passwordHash).toBe("h(old password here)");
  });
});

describe("POST /api/auth/redeem — dead links", () => {
  it("404 for used, unknown, missing and setup tokens", async () => {
    for (const token of ["used", "nope", undefined, 42, "SETUPCODE"]) {
      const res = await POST(req({ token, username: "someone", displayName: "S", password: PW }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(GONE);
    }
    expect(m.users.size).toBe(2);
  });

  it("404 when the token is used between the peek and the transaction (lost race)", async () => {
    // Peek sees it live; by the time the transaction runs another tab has consumed it.
    m.db.authToken.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(req({ token: "inv-user", username: "racer", displayName: "R", password: PW }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GONE);
    expect(m.users.get("id-racer")).toBeUndefined();
  });

  it("400 Invalid request on a non-object body", async () => {
    for (const body of ["not json", "[]", "null"]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    }
  });
});
