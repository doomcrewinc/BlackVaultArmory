import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashToken } from "@/lib/auth/tokens";

type UserRow = { id: string; username: string; displayName: string; role: string; passwordHash: string; disabledAt: Date | null };

const m = vi.hoisted(() => {
  const users = new Map<string, UserRow>();
  return {
    users,
    findUnique: vi.fn(async ({ where }: { where: { username: string } }) => users.get(where.username) ?? null),
    update: vi.fn<(args: { where: { id: string }; data: Record<string, unknown> }) => Promise<object>>(async () => ({})),
    sessionCreate: vi.fn<(args: { data: { userId: string } }) => Promise<object>>(async () => ({})),
    sessionDeleteMany: vi.fn(async () => ({ count: 1 })),
    // Stand-ins: the real scrypt is ~100 ms per call; these keep the throttle tests fast.
    verifyPassword: vi.fn(async (pw: string, stored: string) => ({ ok: stored === `h(${pw})`, needsRehash: false })),
    dummyVerify: vi.fn(async () => {}),
    hashPassword: vi.fn(async (pw: string) => `h2(${pw})`),
    recordEvent: vi.fn(async (_client: unknown, _e: { action: string }) => {}),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.findUnique, update: m.update },
    session: { create: m.sessionCreate, deleteMany: m.sessionDeleteMany },
  },
}));
vi.mock("@/lib/auth/password", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/password")>("@/lib/auth/password");
  return { ...actual, verifyPassword: m.verifyPassword, dummyVerify: m.dummyVerify, hashPassword: m.hashPassword };
});
vi.mock("@/lib/audit/events", () => ({
  recordEvent: m.recordEvent,
  // Mirrors the real recordEventBestEffort: swallow + log, but still call the same
  // spy other assertions check, so a test can prove the route survives a failure.
  recordEventBestEffort: async (client: unknown, e: { action: string }) => {
    try {
      await m.recordEvent(client, e);
    } catch (err) {
      console.error(`[audit] failed to record ${e.action} (request otherwise succeeded):`, err);
    }
  },
}));

import { POST } from "./route";
import { loginThrottle } from "@/lib/auth/throttle";

const PW = "correct horse battery";
const saved = { ...process.env };

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function addUser(username: string, extra: Partial<UserRow> = {}) {
  m.users.set(username, {
    id: `id-${username}`,
    username,
    displayName: username,
    role: "USER",
    passwordHash: `h(${PW})`,
    disabledAt: null,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.users.clear();
  delete process.env.TRUSTED_PROXIES;
});
afterEach(() => {
  process.env = { ...saved };
});

// The throttle is a process-wide singleton; every test uses its own usernames/IPs.
describe("POST /api/auth/login", () => {
  it("unknown user and wrong password give byte-identical status and body", async () => {
    addUser("known1");
    const unknown = await POST(req({ username: "nobody1", password: PW }));
    const wrong = await POST(req({ username: "known1", password: "wrong password here" }));
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const [a, b] = [await unknown.text(), await wrong.text()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ error: "Invalid username or password" });
    expect(unknown.headers.get("set-cookie")).toBeNull();
    expect(wrong.headers.get("set-cookie")).toBeNull();
    // Unknown user still spends a scrypt so it is not faster to reject.
    expect(m.dummyVerify).toHaveBeenCalledOnce();
    // A LOGIN_FAILED event for the unknown username too, with no actor.
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGIN_FAILED",
      changes: { username: "nobody1" },
      actorOverride: { actorId: null, actorName: "anonymous" },
    });
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGIN_FAILED",
      changes: { username: "known1" },
      actorOverride: { actorId: null, actorName: "anonymous" },
    });
  });

  it("caps the recorded username at 64 characters", async () => {
    const long = "a".repeat(100);
    await POST(req({ username: long, password: "wrong password here" }));
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGIN_FAILED",
      changes: { username: "a".repeat(64) },
      actorOverride: { actorId: null, actorName: "anonymous" },
    });
  });

  it("a valid session cookie on the request does not become the LOGIN_FAILED actor", async () => {
    addUser("known-cookie");
    const res = await POST(
      req({ username: "known-cookie", password: "wrong password here" }, { cookie: "bv_session=some-other-users-token" }),
    );
    expect(res.status).toBe(401);
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGIN_FAILED",
      changes: { username: "known-cookie" },
      actorOverride: { actorId: null, actorName: "anonymous" },
    });
  });

  it("a disabled user with the right password gets the same 401 body and no session", async () => {
    addUser("known2");
    addUser("gone2", { disabledAt: new Date("2026-09-01T00:00:00Z") });
    const disabled = await POST(req({ username: "gone2", password: PW }));
    const wrong = await POST(req({ username: "known2", password: "wrong password here" }));
    expect(disabled.status).toBe(401);
    expect(await disabled.text()).toBe(await wrong.text());
    expect(disabled.headers.get("set-cookie")).toBeNull();
    expect(m.sessionCreate).not.toHaveBeenCalled();
  });

  it("the 6th consecutive failure is refused with 429 and Retry-After: 1", async () => {
    addUser("throttled3");
    for (let i = 0; i < 5; i++) {
      expect((await POST(req({ username: "throttled3", password: "wrong password here" }))).status).toBe(401);
    }
    const sixth = await POST(req({ username: "throttled3", password: "wrong password here" }));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("1");
    expect(await sixth.json()).toEqual({ error: "Too many attempts" });
    // Even the right password is refused while throttled — and the key is the NORMALISED name.
    const right = await POST(req({ username: " Throttled3 ", password: PW }));
    expect(right.status).toBe(429);
    expect(m.sessionCreate).not.toHaveBeenCalled();
  });

  it("unknown usernames are throttled exactly like real ones (no enumeration via 429)", async () => {
    for (let i = 0; i < 5; i++) await POST(req({ username: "ghost4", password: "wrong password here" }));
    expect((await POST(req({ username: "ghost4", password: PW }))).status).toBe(429);
  });

  it("with TRUSTED_PROXIES, failures across usernames throttle the LAST X-Forwarded-For address", async () => {
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
    // The client controls everything before the last entry; rotating it must not help.
    const xff = (i: number) => ({ "x-forwarded-for": `198.51.100.${i}, 203.0.113.5` });
    for (let i = 0; i < 5; i++) {
      expect((await POST(req({ username: `spray5-${i}`, password: "wrong password here" }, xff(i)))).status).toBe(401);
    }
    const res = await POST(req({ username: "spray5-new", password: "wrong password here" }, xff(99)));
    expect(res.status).toBe(429);
    // A different proxy-observed address is unaffected.
    const other = await POST(req({ username: "spray5-new2", password: "wrong password here" }, { "x-forwarded-for": "203.0.113.5, 203.0.113.6" }));
    expect(other.status).toBe(401);
  });

  it("keys the per-IP throttle on the last X-Forwarded-For value", async () => {
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";
    const fail = vi.spyOn(loginThrottle, "fail");
    await POST(req({ username: "xffkey11", password: "wrong password here" }, { "x-forwarded-for": "1.2.3.4, 10.0.0.9" }));
    expect(fail.mock.calls.map((c) => c[0])).toEqual(["u:xffkey11", "ip:10.0.0.9"]);
    fail.mockRestore();
  });

  it("without TRUSTED_PROXIES, X-Forwarded-For is ignored for throttling", async () => {
    const xff = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 6; i++) {
      expect((await POST(req({ username: `spray6-${i}`, password: "wrong password here" }, xff))).status).toBe(401);
    }
  });

  it("success sets the session cookie, returns a sanitised next, and records lastLoginAt", async () => {
    addUser("jeff7");
    const ok = await POST(req({ username: " Jeff7 ", password: PW, next: "/vault?tab=all" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ next: "/vault?tab=all" });
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bv_session=");
    expect(cookie).toContain("HttpOnly");
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGIN",
      entityType: "User",
      entityId: "id-jeff7",
      entityLabel: "jeff7 (@jeff7)",
      actorOverride: { actorId: "id-jeff7", actorName: "jeff7 (@jeff7)" },
    });
    expect(m.sessionCreate).toHaveBeenCalledOnce();
    expect(m.sessionCreate.mock.calls[0][0].data.userId).toBe("id-jeff7");
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "id-jeff7" }, data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) }),
    );
    expect(m.update.mock.calls[0][0].data.passwordHash).toBeUndefined();

    for (const next of ["//evil.com", "https://evil.com", "/login", undefined, 42]) {
      const res = await POST(req({ username: "jeff7", password: PW, next }));
      expect(await res.json()).toEqual({ next: "/" });
    }
  });

  it("rehashes the password when verify says the parameters are stale", async () => {
    addUser("old8");
    m.verifyPassword.mockResolvedValueOnce({ ok: true, needsRehash: true });
    const res = await POST(req({ username: "old8", password: PW }));
    expect(res.status).toBe(200);
    expect(m.update.mock.calls[0][0].data.passwordHash).toBe(`h2(${PW})`);
  });

  it("a success clears the failure count", async () => {
    addUser("reset9");
    for (let i = 0; i < 4; i++) await POST(req({ username: "reset9", password: "wrong password here" }));
    expect((await POST(req({ username: "reset9", password: PW }))).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await POST(req({ username: "reset9", password: "wrong password here" }))).status).toBe(401);
    }
  });

  it("rotates: deletes the session named by an incoming bv_session cookie", async () => {
    addUser("rot10");
    const res = await POST(req({ username: "rot10", password: PW }, { cookie: "bv_session=old-token" }));
    expect(res.status).toBe(200);
    expect(m.sessionDeleteMany).toHaveBeenCalledWith({ where: { tokenHash: hashToken("old-token") } });
  });

  it("400 Invalid request on a non-object body or non-string fields", async () => {
    for (const body of ["not json", "[]", "null", { username: 1, password: PW }, { username: "x" }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    }
  });
});
