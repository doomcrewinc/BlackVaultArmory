import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  changeRoleOrStatus: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: m.validateSession }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/admins", () => ({ changeRoleOrStatus: m.changeRoleOrStatus }));

import { PATCH } from "./route";

const ADMIN = { sessionId: "s1", user: { id: "a1", username: "admin", displayName: "Admin", role: "ADMIN" } };
const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };

function patch(body: unknown, id = "u1") {
  return [
    new NextRequest(`http://localhost/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/admin/users/[id]", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await PATCH(...patch({ role: "ADMIN" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(m.changeRoleOrStatus).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER (cannot promote self)", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await PATCH(...patch({ role: "ADMIN" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
    expect(m.changeRoleOrStatus).not.toHaveBeenCalled();
  });

  it("passes role/disabled and the acting admin to changeRoleOrStatus", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.changeRoleOrStatus.mockResolvedValue({ ok: true });
    const res = await PATCH(...patch({ role: "USER", disabled: true, extra: "ignored" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.changeRoleOrStatus).toHaveBeenCalledWith("u1", { role: "USER", disabled: true }, "a1");
  });

  it("omits fields that were not sent", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.changeRoleOrStatus.mockResolvedValue({ ok: true });
    await PATCH(...patch({ disabled: false }));
    expect(m.changeRoleOrStatus).toHaveBeenCalledWith("u1", { disabled: false }, "a1");
  });

  it("last active admin → 409 with the exact body", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.changeRoleOrStatus.mockResolvedValue({ ok: false, status: 409, error: "At least one active admin is required" });
    const res = await PATCH(...patch({ role: "USER" }, "a1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "At least one active admin is required" });
  });

  it("404 / 400 from changeRoleOrStatus pass through", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    m.changeRoleOrStatus.mockResolvedValue({ ok: false, status: 404, error: "User not found" });
    const res = await PATCH(...patch({ role: "USER" }, "zz"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "User not found" });
  });

  it("malformed JSON → 400 Invalid request", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    const res = await PATCH(...patch("{nope"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
    expect(m.changeRoleOrStatus).not.toHaveBeenCalled();
  });
});
