import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  validateSession: vi.fn(),
  endSession: vi.fn(async () => {}),
  endUserSessions: vi.fn(async () => {}),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/sessions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/sessions")>("@/lib/auth/sessions");
  return { ...actual, validateSession: m.validateSession, endSession: m.endSession, endUserSessions: m.endUserSessions };
});

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
  });

  it("?all=1 ends every session of the user", async () => {
    m.validateSession.mockResolvedValue(SIGNED_IN);
    const res = await POST(req("?all=1", "bv_session=tok"));
    expect(res.status).toBe(200);
    expect(m.endUserSessions).toHaveBeenCalledWith("u1");
    expect(m.endSession).not.toHaveBeenCalled();
    expectCleared(res);
  });

  it("without a valid session still answers 200 and clears the cookie", async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await POST(req("?all=1"));
    expect(res.status).toBe(200);
    expect(m.endSession).not.toHaveBeenCalled();
    expect(m.endUserSessions).not.toHaveBeenCalled();
    expectCleared(res);
  });
});
