import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  userCount: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    authToken: { create: m.create, findUnique: m.findUnique, updateMany: m.updateMany, deleteMany: m.deleteMany },
    user: { count: m.userCount },
  },
}));

import { consumeToken, createInvite, ensureSetupToken, generateSetupCode, generateToken, hashToken, peekToken, TOKEN_TTL_MS } from "./tokens";

beforeEach(() => vi.clearAllMocks());

describe("token primitives", () => {
  it("generates 43-char base64url tokens that differ", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });
  it("hashes to 64 hex chars, deterministically", () => {
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });
  it("setup codes use the unambiguous alphabet", () => {
    expect(generateSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  });
  it("setup codes hash the same regardless of case and dashes", () => {
    expect(hashToken("abcd-efgh-jkmn-pqrs".toUpperCase().replace(/[^A-Z0-9]/g, ""))).toBe(
      hashToken("ABCDEFGHJKMNPQRS"),
    );
  });
});

describe("createInvite", () => {
  it("stores only the hash and a 7-day expiry", async () => {
    const now = new Date("2026-09-27T00:00:00Z");
    const { token, expiresAt } = await createInvite({ role: "USER", createdById: "u1", now });
    expect(expiresAt.getTime()).toBe(now.getTime() + TOKEN_TTL_MS.INVITE);
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "INVITE", role: "USER", createdById: "u1", tokenHash: hashToken(token) });
    expect(JSON.stringify(data)).not.toContain(token);
  });
});

describe("ensureSetupToken", () => {
  it("returns null once any user exists", async () => {
    m.userCount.mockResolvedValue(1);
    expect(await ensureSetupToken()).toBeNull();
    expect(m.create).not.toHaveBeenCalled();
  });
  it("replaces unused setup tokens with a fresh one when no user exists", async () => {
    m.userCount.mockResolvedValue(0);
    const code = await ensureSetupToken();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { kind: "SETUP", usedAt: null } });
    expect(m.create.mock.calls[0][0].data).toMatchObject({ kind: "SETUP", expiresAt: null });
  });
});

describe("consumeToken", () => {
  const tx = { authToken: { updateMany: vi.fn(), findUnique: vi.fn() } };
  beforeEach(() => {
    tx.authToken.updateMany.mockReset();
    tx.authToken.findUnique.mockReset();
  });

  it("is a conditional update on unused + unexpired + kind", async () => {
    tx.authToken.updateMany.mockResolvedValue({ count: 1 });
    tx.authToken.findUnique.mockResolvedValue({ role: "USER", userId: null });
    const now = new Date("2026-09-27T00:00:00Z");
    expect(await consumeToken("raw", "INVITE", tx as never, now)).toEqual({ role: "USER", userId: null });
    expect(tx.authToken.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken("raw"), kind: "INVITE", usedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      data: { usedAt: now },
    });
  });

  it("returns null when the conditional update matched nothing (used, expired, wrong kind, or lost a race)", async () => {
    tx.authToken.updateMany.mockResolvedValue({ count: 0 });
    expect(await consumeToken("raw", "INVITE", tx as never)).toBeNull();
  });
});

describe("peekToken", () => {
  it("rejects used and expired tokens", async () => {
    const now = new Date("2026-09-27T00:00:00Z");
    m.findUnique.mockResolvedValue({ kind: "INVITE", role: "USER", userId: null, usedAt: now, expiresAt: null });
    expect(await peekToken("raw", now)).toBeNull();
    m.findUnique.mockResolvedValue({ kind: "INVITE", role: "USER", userId: null, usedAt: null, expiresAt: new Date(now.getTime() - 1) });
    expect(await peekToken("raw", now)).toBeNull();
    m.findUnique.mockResolvedValue({ kind: "RESET", role: null, userId: "u2", usedAt: null, expiresAt: new Date(now.getTime() + 1) });
    expect(await peekToken("raw", now)).toEqual({ kind: "RESET", role: null, userId: "u2" });
  });
});
