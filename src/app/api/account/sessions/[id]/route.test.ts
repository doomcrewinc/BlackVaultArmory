import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/sessions")>("@/lib/auth/sessions");
  return { ...actual, validateSession: m.validateSession };
});
vi.mock("@/lib/prisma", () => ({ prisma: { session: { deleteMany: m.deleteMany } } }));

import { DELETE } from "./route";

const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };

function del(id: string) {
  return [
    new NextRequest(`http://localhost/api/account/sessions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/account/sessions/[id]", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await DELETE(...del("s9"));
    expect(res.status).toBe(401);
    expect(m.deleteMany).not.toHaveBeenCalled();
  });

  it("ends one of the user's own sessions, scoped to the user", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(...del("s9"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { id: "s9", userId: "u1" } });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("someone else's (or an unknown) session → 404", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(...del("other"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("ending the current session also clears the cookie", async () => {
    m.validateSession.mockResolvedValue(USER);
    m.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(...del("s2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/^bv_session=;.*Max-Age=0/i);
  });
});
