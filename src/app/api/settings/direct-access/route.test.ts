import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  upsert: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: m.validateSession }));
vi.mock("@/lib/prisma", () => ({ prisma: { appSettings: { upsert: m.upsert, findUnique: m.findUnique } } }));

import { readStoredDirectAccess, resetDirectAccessCacheForTests } from "@/lib/server/direct-access";
import { PUT } from "./route";

const ADMIN = { sessionId: "s1", user: { id: "a1", username: "admin", displayName: "Admin", role: "ADMIN" } };
const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };

function put(body: unknown) {
  return new NextRequest("http://localhost/api/settings/direct-access", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALLOW_DIRECT_ACCESS;
  resetDirectAccessCacheForTests();
  m.upsert.mockImplementation(async ({ update }: { update: { allowDirectAccess: boolean } }) => ({
    allowDirectAccess: update.allowDirectAccess,
  }));
});

describe("PUT /api/settings/direct-access", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await PUT(put({ allowDirectAccess: true }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await PUT(put({ allowDirectAccess: true }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("409 when the environment forces direct access on", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    process.env.ALLOW_DIRECT_ACCESS = "true";
    const res = await PUT(put({ allowDirectAccess: false }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Direct access is forced on by BLACKVAULT_ALLOW_DIRECT_ACCESS" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ allowDirectAccess: "true" }], [{ allowDirectAccess: null }], ["{bad"]])(
    "invalid body %j → 400 Invalid request",
    async (body) => {
      m.validateSession.mockResolvedValue(ADMIN);
      const res = await PUT(put(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
      expect(m.upsert).not.toHaveBeenCalled();
    },
  );

  it("stores the setting and returns the new state", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    const res = await PUT(put({ allowDirectAccess: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, source: "setting" });
    expect(m.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { id: "singleton", allowDirectAccess: true },
      update: { allowDirectAccess: true },
    });
  });

  it("invalidates the direct-access cache so the next read sees the change immediately", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.findUnique.mockResolvedValueOnce({ allowDirectAccess: false });
    expect(await readStoredDirectAccess()).toBe(false); // now cached for 5 s
    m.findUnique.mockResolvedValueOnce({ allowDirectAccess: true });
    expect(await readStoredDirectAccess()).toBe(false); // still the cached value

    expect((await PUT(put({ allowDirectAccess: true }))).status).toBe(200);
    expect(await readStoredDirectAccess()).toBe(true);
    expect(m.findUnique).toHaveBeenCalledTimes(2);
  });
});
