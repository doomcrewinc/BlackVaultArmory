import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  findMany: vi.fn(),
  createInvite: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: m.validateSession }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: m.findMany } } }));
vi.mock("@/lib/auth/tokens", () => ({ createInvite: m.createInvite }));

import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";
import { GET, POST } from "./route";

const ADMIN = { sessionId: "s1", user: { id: "a1", username: "admin", displayName: "Admin", role: "ADMIN" } };
const USER = { sessionId: "s2", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } };
const EXPIRES = new Date("2026-10-04T00:00:00.000Z");

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_URL = "https://vault.example.com";
  resetPublicUrlCacheForTests();
  m.createInvite.mockResolvedValue({ token: "TOK", expiresAt: EXPIRES });
});

describe("GET /api/admin/users", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
    expect(m.findMany).not.toHaveBeenCalled();
  });

  it("lists users without password hashes", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    const created = new Date("2026-09-01T00:00:00.000Z");
    m.findMany.mockResolvedValue([
      { id: "a1", username: "admin", displayName: "Admin", role: "ADMIN", disabledAt: null, createdAt: created, lastLoginAt: null },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      users: [
        {
          id: "a1",
          username: "admin",
          displayName: "Admin",
          role: "ADMIN",
          disabledAt: null,
          createdAt: created.toISOString(),
          lastLoginAt: null,
        },
      ],
    });
    const select = m.findMany.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(Object.keys(select).sort()).toEqual(
      ["createdAt", "disabledAt", "displayName", "id", "lastLoginAt", "role", "username"].sort(),
    );
  });
});

describe("POST /api/admin/users (invite)", () => {
  it("401 when signed out", async () => {
    m.validateSession.mockResolvedValue(null);
    expect((await POST(post({}))).status).toBe(401);
    expect(m.createInvite).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.validateSession.mockResolvedValue(USER);
    const res = await POST(post({ role: "ADMIN" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
    expect(m.createInvite).not.toHaveBeenCalled();
  });

  it("defaults the role to USER and returns the public invite URL", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    const res = await POST(post({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://vault.example.com/invite/TOK",
      expiresAt: EXPIRES.toISOString(),
    });
    expect(m.createInvite).toHaveBeenCalledWith({ role: "USER", createdById: "a1" });
  });

  it("accepts role ADMIN", async () => {
    m.validateSession.mockResolvedValue(ADMIN);
    expect((await POST(post({ role: "ADMIN" }))).status).toBe(200);
    expect(m.createInvite).toHaveBeenCalledWith({ role: "ADMIN", createdById: "a1" });
  });

  it.each([[{ role: "OWNER" }], [{ role: "admin" }], [{ role: 1 }], [{ role: null }], ["not json"], [[1]]])(
    "invalid body %j → 400 Invalid request",
    async (body) => {
      m.validateSession.mockResolvedValue(ADMIN);
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request" });
      expect(m.createInvite).not.toHaveBeenCalled();
    },
  );
});
