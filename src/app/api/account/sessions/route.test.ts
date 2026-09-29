import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: m.validateSession }));
vi.mock("@/lib/prisma", () => ({ prisma: { session: { findMany: m.findMany } } }));

import { GET } from "./route";

const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };
const T = (s: string) => new Date(`2026-09-${s}T00:00:00.000Z`);

beforeEach(() => vi.clearAllMocks());

describe("GET /api/account/sessions", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("lists only the user's unexpired sessions, marking the current one, never the token hash", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.findMany.mockResolvedValue([
      { id: "s2", createdAt: T("20"), lastSeenAt: T("27"), expiresAt: T("30"), userAgent: "Firefox" },
      { id: "s9", createdAt: T("01"), lastSeenAt: T("02"), expiresAt: T("30"), userAgent: null },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions.map((s: { id: string; current: boolean }) => [s.id, s.current])).toEqual([
      ["s2", true],
      ["s9", false],
    ]);
    const args = m.findMany.mock.calls[0][0];
    expect(args.where.userId).toBe("u1");
    expect(args.where.expiresAt.gt).toBeInstanceOf(Date);
    expect(args.select.tokenHash).toBeUndefined();
  });
});
