import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  upsert: vi.fn(),
  findUnique: vi.fn(),
  recordEvent: vi.fn(async (_client: unknown, _e: { action: string }) => {}),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: m.validateSession }));
vi.mock("@/lib/prisma", () => ({ prisma: { appSettings: { upsert: m.upsert, findUnique: m.findUnique } } }));
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
  m.findUnique.mockResolvedValue({ allowDirectAccess: false });
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

  it("stores the setting, returns the new state, and records DIRECT_ACCESS_CHANGED", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    const res = await PUT(put({ allowDirectAccess: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, source: "setting" });
    expect(m.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { id: "singleton", allowDirectAccess: true },
      update: { allowDirectAccess: true },
    });
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "DIRECT_ACCESS_CHANGED",
      entityType: "AppSettings",
      entityId: "singleton",
      changes: { from: false, to: true },
    });
  });

  it("no row yet (null from) is treated as false", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.findUnique.mockResolvedValue(null);
    await PUT(put({ allowDirectAccess: true }));
    expect(m.recordEvent).toHaveBeenCalledWith(null, expect.objectContaining({ changes: { from: false, to: true } }));
  });

  it("setting it to the value it already has records no event", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.findUnique.mockResolvedValue({ allowDirectAccess: true });
    const res = await PUT(put({ allowDirectAccess: true }));
    expect(res.status).toBe(200);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("invalidates the direct-access cache so the next read sees the change immediately", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.findUnique.mockReset();
    m.findUnique.mockResolvedValueOnce({ allowDirectAccess: false }); // readStoredDirectAccess seed
    expect(await readStoredDirectAccess()).toBe(false); // now cached for 5 s
    expect(await readStoredDirectAccess()).toBe(false); // still the cached value, no extra call

    m.findUnique.mockResolvedValueOnce({ allowDirectAccess: false }); // PUT's own "from" read
    expect((await PUT(put({ allowDirectAccess: true }))).status).toBe(200);

    m.findUnique.mockResolvedValueOnce({ allowDirectAccess: true }); // cache was invalidated
    expect(await readStoredDirectAccess()).toBe(true);
    expect(m.findUnique).toHaveBeenCalledTimes(3);
  });
});
