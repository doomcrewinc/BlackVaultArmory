import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  endUserSessions: vi.fn(async () => {}),
  findUnique: vi.fn(),
  update: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(async () => "scrypt$new"),
  recordEvent: vi.fn(async (_client: unknown, _e: { action: string }) => {}),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({
  SESSION_COOKIE: "bv_session",
  validateSession: m.validateSession,
  endUserSessions: m.endUserSessions,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: m.findUnique, update: m.update } } }));
vi.mock("@/lib/auth/password", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/password")>("@/lib/auth/password");
  return { ...actual, verifyPassword: m.verifyPassword, hashPassword: m.hashPassword };
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

import { GET, PATCH } from "./route";

const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };
const NEW_PW = "a brand new passphrase";

function patch(body: unknown) {
  return new NextRequest("http://localhost/api/account", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.findUnique.mockResolvedValue({ id: "u1", passwordHash: "scrypt$old" });
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "u1",
    username: "jeff",
    displayName: (data.displayName as string) ?? "Jeff",
    role: "USER",
  }));
});

describe("GET /api/account", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("returns the signed-in user (a USER is allowed)", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "u1", username: "jeff", displayName: "Jeff", role: "USER" });
  });
});

describe("PATCH /api/account", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await PATCH(patch({ displayName: "X" }));
    expect(res.status).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("changes the display name (trimmed) without touching sessions", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await PATCH(patch({ displayName: "  Jeffrey  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "u1", username: "jeff", displayName: "Jeffrey", role: "USER" });
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" }, data: { displayName: "Jeffrey" } }));
    expect(m.endUserSessions).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "], ["x".repeat(65)]])("invalid display name %j → 400", async (displayName) => {
    m.validateSession.mockResolvedValue(USER);
    const res = await PATCH(patch({ displayName }));
    expect(res.status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("wrong current password → 401 Current password is incorrect, nothing written", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.verifyPassword.mockResolvedValue({ ok: false, needsRehash: false });
    const res = await PATCH(patch({ currentPassword: "wrong one here", newPassword: NEW_PW }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Current password is incorrect" });
    expect(m.verifyPassword).toHaveBeenCalledWith("wrong one here", "scrypt$old");
    expect(m.update).not.toHaveBeenCalled();
    expect(m.endUserSessions).not.toHaveBeenCalled();
  });

  it("missing current password → 401", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await PATCH(patch({ newPassword: NEW_PW }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Current password is incorrect" });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("new password too short → 400, nothing written", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.verifyPassword.mockResolvedValue({ ok: true, needsRehash: false });
    const res = await PATCH(patch({ currentPassword: "old passphrase!", newPassword: "short" }));
    expect(res.status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("right current password → hash stored and every OTHER session ended", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.verifyPassword.mockResolvedValue({ ok: true, needsRehash: false });
    const res = await PATCH(patch({ currentPassword: "old passphrase!", newPassword: NEW_PW }));
    expect(res.status).toBe(200);
    expect(m.hashPassword).toHaveBeenCalledWith(NEW_PW);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { passwordHash: "scrypt$new" } }));
    expect(m.endUserSessions).toHaveBeenCalledWith("u1", "s2");
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "PASSWORD_CHANGED",
      entityType: "User",
      entityId: "u1",
      entityLabel: "Jeff (@jeff)",
    });
  });

  it("changing only the display name records no PASSWORD_CHANGED event", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await PATCH(patch({ displayName: "Jeffrey" }));
    expect(res.status).toBe(200);
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ displayName: 5 }], [{ newPassword: 5, currentPassword: "x" }], ["{bad"]])(
    "invalid body %j → 400 Invalid request",
    async (body) => {
      m.validateSession.mockResolvedValue(USER);
      const res = await PATCH(patch(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
      expect(m.update).not.toHaveBeenCalled();
    },
  );
});
