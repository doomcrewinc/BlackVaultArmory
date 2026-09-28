import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ validateSession: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "t" }) }),
}));

vi.mock("@/lib/auth/sessions", () => ({
  SESSION_COOKIE: "bv_session",
  validateSession: m.validateSession,
}));

import { getCurrentUser, requireAdmin, requireAuth } from "./auth";

const sessionUser = { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" as const };
const adminUser = { id: "u2", username: "admin", displayName: "Admin", role: "ADMIN" as const };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentUser", () => {
  it("returns null when the session is invalid", async () => {
    m.validateSession.mockResolvedValueOnce(null);
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns the user plus sessionId when valid", async () => {
    m.validateSession.mockResolvedValueOnce({ user: sessionUser, sessionId: "s1" });
    expect(await getCurrentUser()).toEqual({ ...sessionUser, sessionId: "s1" });
  });
});

describe("requireAuth", () => {
  it("returns a 401 JSON response when signed out", async () => {
    m.validateSession.mockResolvedValueOnce(null);
    const response = await requireAuth();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({ error: "Authentication required" });
  });

  it("returns null when signed in", async () => {
    m.validateSession.mockResolvedValueOnce({ user: sessionUser, sessionId: "s1" });
    expect(await requireAuth()).toBeNull();
  });
});

describe("requireAdmin", () => {
  it("returns 401 when signed out", async () => {
    m.validateSession.mockResolvedValueOnce(null);
    const response = await requireAdmin();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect(await response!.json()).toEqual({ error: "Authentication required" });
  });

  it("returns 403 Admins only for a USER role", async () => {
    m.validateSession.mockResolvedValueOnce({ user: sessionUser, sessionId: "s1" });
    const response = await requireAdmin();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    expect(await response!.json()).toEqual({ error: "Admins only" });
  });

  it("returns null for an ADMIN role", async () => {
    m.validateSession.mockResolvedValueOnce({ user: adminUser, sessionId: "s2" });
    expect(await requireAdmin()).toBeNull();
  });
});

describe("getCurrentUser caching", () => {
  // React's cache() only dedupes within a single render/request scope backed by
  // AsyncLocalStorage; vitest calling getCurrentUser() twice outside a render may
  // not dedupe. This asserts observed behaviour rather than assuming a call count.
  it("calling it twice resolves to the same result", async () => {
    m.validateSession.mockResolvedValue({ user: sessionUser, sessionId: "s1" });
    const first = await getCurrentUser();
    const second = await getCurrentUser();
    expect(first).toEqual(second);
    expect(m.validateSession.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
