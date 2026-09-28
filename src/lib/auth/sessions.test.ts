import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
  isSecureRequest: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { session: { create: m.create, findUnique: m.findUnique, update: m.update, delete: m.delete, deleteMany: m.deleteMany } },
}));
vi.mock("@/lib/server/request-gate", () => ({ isSecureRequest: m.isSecureRequest }));

import { clearedSessionCookie, createSession, endUserSessions, SESSION_COOKIE, SESSION_TTL_MS, sessionCookie, validateSession } from "./sessions";
import { hashToken } from "./tokens";

const now = new Date("2026-09-27T12:00:00Z");
const user = { id: "u1", username: "jeff", displayName: "Jeff", role: "USER", disabledAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createSession", () => {
  it("stores the token hash and a 30-day expiry", async () => {
    const { token, expiresAt } = await createSession("u1", "Mozilla", now);
    expect(expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
    expect(m.create.mock.calls[0][0].data).toMatchObject({ userId: "u1", tokenHash: hashToken(token), userAgent: "Mozilla" });
  });
});

describe("validateSession", () => {
  it("rejects a missing cookie without touching the DB", async () => {
    expect(await validateSession(undefined, now)).toBeNull();
    expect(m.findUnique).not.toHaveBeenCalled();
  });
  it("rejects unknown, expired and disabled", async () => {
    m.findUnique.mockResolvedValueOnce(null);
    expect(await validateSession("t", now)).toBeNull();
    m.findUnique.mockResolvedValueOnce({ id: "s1", expiresAt: new Date(now.getTime() - 1), lastSeenAt: now, user });
    expect(await validateSession("t", now)).toBeNull();
    m.findUnique.mockResolvedValueOnce({ id: "s1", expiresAt: new Date(now.getTime() + 1000), lastSeenAt: now, user: { ...user, disabledAt: now } });
    expect(await validateSession("t", now)).toBeNull();
  });
  it("returns the user and does not write within the slide interval", async () => {
    m.findUnique.mockResolvedValueOnce({ id: "s1", expiresAt: new Date(now.getTime() + 1000), lastSeenAt: new Date(now.getTime() - 60_000), user });
    expect(await validateSession("t", now)).toEqual({ sessionId: "s1", user: { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" } });
    expect(m.update).not.toHaveBeenCalled();
  });
  it("slides the expiry once the interval has passed", async () => {
    m.findUnique.mockResolvedValueOnce({ id: "s1", expiresAt: new Date(now.getTime() + 1000), lastSeenAt: new Date(now.getTime() - 3_600_001), user });
    await validateSession("t", now);
    expect(m.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } });
  });
  it("returns slidTo when it slides the expiry", async () => {
    m.findUnique.mockResolvedValueOnce({ id: "s1", expiresAt: new Date(now.getTime() + 1000), lastSeenAt: new Date(now.getTime() - 3_600_001), user });
    const result = await validateSession("t", now);
    expect(result?.slidTo).toEqual(new Date(now.getTime() + SESSION_TTL_MS));
  });
  it("does not include slidTo when it does not slide", async () => {
    m.findUnique.mockResolvedValueOnce({ id: "s1", expiresAt: new Date(now.getTime() + 1000), lastSeenAt: new Date(now.getTime() - 60_000), user });
    const result = await validateSession("t", now);
    expect(result?.slidTo).toBeUndefined();
  });
  it("returns null (never throws) when the DB fails", async () => {
    m.findUnique.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    expect(await validateSession("t", now)).toBeNull();
  });
  it("rejects an unrecognised role", async () => {
    m.findUnique.mockResolvedValueOnce({
      id: "s1",
      expiresAt: new Date(now.getTime() + 1000),
      lastSeenAt: now,
      user: { ...user, role: "OWNER" },
    });
    expect(await validateSession("t", now)).toBeNull();
  });
});

describe("endUserSessions", () => {
  it("can keep the current session", async () => {
    await endUserSessions("u1", "s1");
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1", NOT: { id: "s1" } } });
  });
});

describe("sessionCookie", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins name, httpOnly, sameSite, path, secure and a maxAge in whole seconds", () => {
    m.isSecureRequest.mockReturnValue(true);
    const request = new Request("https://example.com/");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    expect(sessionCookie("tok", expiresAt, request)).toEqual({
      name: SESSION_COOKIE,
      value: "tok",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      expires: expiresAt,
      maxAge: 30 * 86_400,
    });
  });

  it("secure follows isSecureRequest when false", () => {
    m.isSecureRequest.mockReturnValue(false);
    const request = new Request("http://example.com/");
    expect(sessionCookie("tok", new Date(now.getTime() + 1000), request).secure).toBe(false);
  });

  it("never returns a negative maxAge for an already-expired expiresAt", () => {
    m.isSecureRequest.mockReturnValue(true);
    const request = new Request("https://example.com/");
    expect(sessionCookie("tok", new Date(now.getTime() - 1000), request).maxAge).toBe(0);
  });
});

describe("clearedSessionCookie", () => {
  it("clears the cookie: empty value and maxAge 0, other attributes unchanged", () => {
    m.isSecureRequest.mockReturnValue(true);
    const request = new Request("https://example.com/");
    expect(clearedSessionCookie(request)).toEqual({
      name: SESSION_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      expires: new Date(0),
      maxAge: 0,
    });
  });
});
