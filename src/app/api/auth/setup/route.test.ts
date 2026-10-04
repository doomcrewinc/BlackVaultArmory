import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashToken } from "@/lib/auth/tokens";

/**
 * A tiny in-memory stand-in for the three tables setup touches, so "second call → 404" and
 * "the code is single-use" are observed through state rather than asserted on call shapes.
 */
const m = vi.hoisted(() => {
  const state = {
    setupHash: "",
    setupUsed: false,
    users: [] as { id: string; username: string; displayName: string; role: string; passwordHash: string }[],
  };
  const db = {
    user: {
      count: vi.fn(async () => state.users.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const user = { id: `u${state.users.length + 1}`, ...data } as (typeof state.users)[number];
        state.users.push(user);
        return user;
      }),
    },
    authToken: {
      updateMany: vi.fn(async ({ where }: { where: { tokenHash: string; kind: string } }) => {
        if (where.kind === "SETUP" && where.tokenHash === state.setupHash && !state.setupUsed) {
          state.setupUsed = true;
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findUnique: vi.fn(async () => ({ role: null, userId: null })),
    },
    session: { create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  return { state, db, markUsersExist: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({ prisma: m.db }));
vi.mock("@/lib/auth/setup-state", () => ({ markUsersExist: m.markUsersExist }));
vi.mock("@/lib/auth/password", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/password")>("@/lib/auth/password");
  return { ...actual, hashPassword: vi.fn(async (pw: string) => `h(${pw})`) };
});

import { POST } from "./route";

const CODE = "ABCD-EFGH-JKMN-PQRS";
const VALID = { username: " Jeff ", displayName: "Jeff", password: "correct horse battery" };

function req(body: unknown) {
  return new NextRequest("http://localhost/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.state.setupHash = hashToken("ABCDEFGHJKMNPQRS");
  m.state.setupUsed = false;
  m.state.users = [];
});

describe("POST /api/auth/setup", () => {
  it("403 without a setup code", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Invalid setup code" });
    expect(m.state.users).toHaveLength(0);
  });

  it("403 with a wrong setup code", async () => {
    const res = await POST(req({ ...VALID, setupCode: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Invalid setup code" });
    expect(m.state.users).toHaveLength(0);
  });

  it("201 creates an ADMIN, signs them in, and marks users as existing", async () => {
    // Typed by hand: lowercase with spaces must still match (normaliseSetupCode).
    const res = await POST(req({ ...VALID, setupCode: " abcd efgh-jkmn-pqrs " }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.user).toMatchObject({ username: "jeff", displayName: "Jeff", role: "ADMIN" });
    expect(json.user.passwordHash).toBeUndefined();
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bv_session=");
    expect(cookie).toContain("HttpOnly");
    expect(m.state.users[0]).toMatchObject({ username: "jeff", role: "ADMIN", passwordHash: "h(correct horse battery)" });
    expect(m.state.setupUsed).toBe(true);
    expect(m.markUsersExist).toHaveBeenCalledOnce();
    expect(m.db.session.create).toHaveBeenCalledOnce();
  });

  it("logs one [auth] line when the first admin is created, with no code, name or password in it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await POST(req({ ...VALID, setupCode: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }))).status).toBe(403);
      expect(log).not.toHaveBeenCalled();
      expect((await POST(req({ ...VALID, setupCode: CODE }))).status).toBe(201);
      // scripts/setup-token.sh and :show_setup_token in the .bat installers
      // look for this exact prefix after the last "[auth] Setup token:" line.
      const lines = log.mock.calls.map((c) => c.join(" "));
      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith("[auth] First admin created")).toBe(true);
      expect(lines[0]).not.toMatch(/ABCD|jeff|correct horse/i);
      expect((await POST(req({ ...VALID, username: "other", setupCode: CODE }))).status).toBe(404);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("404 once any user exists — even with the same code again", async () => {
    expect((await POST(req({ ...VALID, setupCode: CODE }))).status).toBe(201);
    const res = await POST(req({ ...VALID, username: "other", setupCode: CODE }));
    expect(res.status).toBe(404);
    expect(m.state.users).toHaveLength(1);
  });

  it("404 when a user appears between the pre-check and the transaction", async () => {
    // Simulates a concurrent setup winning the race: the pre-check sees 0, the tx sees 1.
    m.db.user.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const res = await POST(req({ ...VALID, setupCode: CODE }));
    expect(res.status).toBe(404);
    expect(m.db.user.create).not.toHaveBeenCalled();
    expect(m.markUsersExist).not.toHaveBeenCalled();
  });

  it("400 on validation errors, without consuming the code", async () => {
    for (const bad of [
      { ...VALID, username: "a b" },
      { ...VALID, displayName: "   " },
      { ...VALID, password: "short" },
    ]) {
      const res = await POST(req({ ...bad, setupCode: CODE }));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect(m.state.setupUsed).toBe(false);
  });

  it("400 Invalid request on a non-object body", async () => {
    for (const body of ["not json", "[]", "null", "42"]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    }
  });
});
