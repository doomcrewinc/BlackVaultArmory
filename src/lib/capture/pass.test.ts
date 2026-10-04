import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    capturePass: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, create: mocks.create },
    $transaction: mocks.transaction,
  },
}));

import { PASS_MAX_UPLOADS, PASS_TTL_MS, closePass, createPass, findPass, returnSlot, takeSlot } from "./pass";
import { hashToken } from "@/lib/auth/tokens";

const NOW = new Date("2026-10-04T12:00:00Z");
const later = new Date(NOW.getTime() + 60_000);
const earlier = new Date(NOW.getTime() - 60_000);

function row(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    entityType: "gear",
    entityId: "g1",
    createdById: "u1",
    expiresAt: later,
    closedAt: null,
    uploadCount: 0,
    createdBy: { displayName: "Ann", username: "ann", disabledAt: null },
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("findPass", () => {
  it("is null for an unknown token and looks it up by hash", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await findPass("raw", NOW)).toBeNull();
    expect(mocks.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: hashToken("raw") });
  });

  it.each([
    ["closedAt is set", { closedAt: earlier }, "closed"],
    ["expiresAt is now", { expiresAt: NOW }, "expired"],
    ["expiresAt has passed", { expiresAt: earlier }, "expired"],
    ["uploadCount reached the limit", { uploadCount: PASS_MAX_UPLOADS }, "full"],
    ["the creator is disabled", { createdBy: { displayName: "A", username: "a", disabledAt: earlier } }, "closed"],
    ["closed and expired and full", { closedAt: earlier, expiresAt: earlier, uploadCount: 50 }, "closed"],
    ["expired and full", { expiresAt: earlier, uploadCount: 50 }, "expired"],
  ])("when %s the reason is %s", async (_label, over, reason) => {
    mocks.findUnique.mockResolvedValue(row(over));
    expect(await findPass("raw", NOW)).toEqual({ ok: false, reason });
  });

  it("returns the open pass with the creator name in the audit format", async () => {
    mocks.findUnique.mockResolvedValue(row({ uploadCount: 49 }));
    expect(await findPass("raw", NOW)).toEqual({
      ok: true,
      pass: {
        id: "p1",
        entityType: "gear",
        entityId: "g1",
        createdById: "u1",
        creatorName: "Ann (@ann)",
        expiresAt: later,
        uploadCount: 49,
      },
    });
  });
});

describe("createPass", () => {
  it("stores the hash, never the token, and expires 15 minutes out", async () => {
    mocks.updateMany.mockReturnValue("close");
    mocks.create.mockReturnValue("create");
    mocks.transaction.mockResolvedValue([{ count: 0 }, { id: "p9" }]);

    const out = await createPass({ entityType: "kit", entityId: "k1", createdById: "u1", sessionId: "s1", now: NOW });

    expect(out.id).toBe("p9");
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + PASS_TTL_MS));
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashToken(out.token));
    expect(JSON.stringify(data)).not.toContain(out.token);
    expect(data).toMatchObject({ entityType: "kit", entityId: "k1", sessionId: "s1", expiresAt: out.expiresAt });
    expect(mocks.updateMany.mock.calls[0][0].where).toEqual({ entityType: "kit", entityId: "k1", closedAt: null });
    expect(mocks.transaction).toHaveBeenCalledWith(["close", "create"]);
  });
});

describe("slots and closing", () => {
  it.each([[1, true], [0, false]])("takeSlot with count %i is %s", async (count, expected) => {
    mocks.updateMany.mockResolvedValue({ count });
    expect(await takeSlot("p1", NOW)).toBe(expected);
    expect(mocks.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "p1", closedAt: null, expiresAt: { gt: NOW }, uploadCount: { lt: PASS_MAX_UPLOADS } },
      data: { uploadCount: { increment: 1 } },
    });
  });

  it("returnSlot decrements only above zero", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await returnSlot("p1");
    expect(mocks.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "p1", uploadCount: { gt: 0 } },
      data: { uploadCount: { decrement: 1 } },
    });
  });

  it.each([[1, true], [0, false]])("closePass with count %i is %s", async (count, expected) => {
    mocks.updateMany.mockResolvedValue({ count });
    expect(await closePass("p1", NOW)).toBe(expected);
    expect(mocks.updateMany.mock.calls[0][0].where).toEqual({ id: "p1", closedAt: null });
  });
});
