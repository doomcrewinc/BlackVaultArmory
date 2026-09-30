import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  endSession: vi.fn(async () => {}),
  endUserSessions: vi.fn(async () => {}),
  recordEvent: vi.fn(async (_client: unknown, _e: { action: string }) => {}),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/sessions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/sessions")>("@/lib/auth/sessions");
  return { ...actual, validateSession: m.validateSession, endSession: m.endSession, endUserSessions: m.endUserSessions };
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

const SIGNED_IN = { sessionId: "s1", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };

function req(query = "", cookie?: string) {
  return new NextRequest(`http://localhost/api/auth/logout${query}`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}

function expectCleared(res: Response) {
  const cookie = res.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^bv_session=;/);
  expect(cookie).toMatch(/Max-Age=0/i);
  expect(cookie).toContain("HttpOnly");
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/auth/logout", () => {
  it("ends the current session and clears the cookie", async () => {
    m.validateSession.mockResolvedValue(SIGNED_IN);
    const res = await POST(req("", "bv_session=tok"));
    expect(res.status).toBe(200);
    expect(m.validateSession).toHaveBeenCalledWith("tok");
    expect(m.endSession).toHaveBeenCalledWith("s1");
    expect(m.endUserSessions).not.toHaveBeenCalled();
    expectCleared(res);
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGOUT",
      entityType: "User",
      entityId: "u1",
      entityLabel: "Jeff (@jeff)",
      actorOverride: { actorId: "u1", actorName: "Jeff (@jeff)" },
    });
  });

  it("?all=1 ends every session of the user, with allSessions in changes", async () => {
    m.validateSession.mockResolvedValue(SIGNED_IN);
    const res = await POST(req("?all=1", "bv_session=tok"));
    expect(res.status).toBe(200);
    expect(m.endUserSessions).toHaveBeenCalledWith("u1");
    expect(m.endSession).not.toHaveBeenCalled();
    expectCleared(res);
    expect(m.recordEvent).toHaveBeenCalledWith(null, {
      action: "LOGOUT",
      entityType: "User",
      entityId: "u1",
      entityLabel: "Jeff (@jeff)",
      actorOverride: { actorId: "u1", actorName: "Jeff (@jeff)" },
      changes: { allSessions: true },
    });
  });

  it("without a valid session still answers 200 and clears the cookie, no event", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await POST(req("?all=1"));
    expect(res.status).toBe(200);
    expect(m.endSession).not.toHaveBeenCalled();
    expect(m.endUserSessions).not.toHaveBeenCalled();
    expect(m.recordEvent).not.toHaveBeenCalled();
    expectCleared(res);
  });
});
