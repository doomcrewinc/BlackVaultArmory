import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  endUserSessions: vi.fn(async () => {}),
  findUnique: vi.fn(),
  createResetLink: vi.fn(),
  recordEvent: vi.fn(async (_client: unknown, _e: { action: string }) => {}),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({
  SESSION_COOKIE: "bv_session",
  validateSession: m.validateSession,
  endUserSessions: m.endUserSessions,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: m.findUnique } } }));
vi.mock("@/lib/auth/tokens", () => ({ createResetLink: m.createResetLink }));
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

import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";
import { POST } from "./route";

const ADMIN = { sessionId: "s1", user: { id: "a1", username: "admin", displayName: "Admin", role: "ADMIN" } };
const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };
const EXPIRES = new Date("2026-09-28T00:00:00.000Z");

function post(id = "u1") {
  return [
    new NextRequest(`http://localhost/api/admin/users/${id}/reset-link`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_URL = "https://vault.example.com";
  resetPublicUrlCacheForTests();
  m.createResetLink.mockResolvedValue({ token: "RST", expiresAt: EXPIRES });
  m.findUnique.mockResolvedValue({ id: "u1", username: "jeff", displayName: "Jeff" });
});

describe("POST /api/admin/users/[id]/reset-link", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await POST(...post());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(m.createResetLink).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await POST(...post());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
    expect(m.createResetLink).not.toHaveBeenCalled();
    expect(m.endUserSessions).not.toHaveBeenCalled();
  });

  it("404 for an unknown user", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.findUnique.mockResolvedValue(null);
    const res = await POST(...post("zz"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "User not found" });
    expect(m.createResetLink).not.toHaveBeenCalled();
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it("returns the public reset URL and ends all of the user's sessions", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    const res = await POST(...post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://vault.example.com/reset/RST",
      expiresAt: EXPIRES.toISOString(),
    });
    expect(m.createResetLink).toHaveBeenCalledWith({ userId: "u1", createdById: "a1" });
    expect(m.endUserSessions).toHaveBeenCalledWith("u1");
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "RESET_LINK_ISSUED",
      entityType: "User",
      entityId: "u1",
      entityLabel: "Jeff (@jeff)",
    });
  });

  it("a reset link for yourself keeps your current session", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.findUnique.mockResolvedValue({ id: "a1", username: "admin", displayName: "Admin" });
    expect((await POST(...post("a1"))).status).toBe(200);
    expect(m.endUserSessions).toHaveBeenCalledWith("a1", "s1");
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "RESET_LINK_ISSUED",
      entityType: "User",
      entityId: "a1",
      entityLabel: "Admin (@admin)",
    });
  });
});
