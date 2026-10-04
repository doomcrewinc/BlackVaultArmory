import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  enforceRateLimit: vi.fn(),
  findOwnerName: vi.fn(),
  record: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock("@/lib/audit/events", () => ({ recordEventBestEffort: mocks.record }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    capturePass: { updateMany: mocks.updateMany, create: mocks.create },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/photos/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/owner")>()),
  findOwnerName: mocks.findOwnerName,
}));

import { POST } from "./route";
import { hashToken } from "@/lib/auth/tokens";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/capture-passes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const valid = { entityType: "ammo", entityId: "a1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getCurrentUser.mockResolvedValue({ id: "u1", username: "ann", displayName: "Ann", role: "USER", sessionId: "s1" });
  mocks.enforceRateLimit.mockResolvedValue({ allowed: true });
  mocks.findOwnerName.mockResolvedValue("9mm Federal");
  mocks.updateMany.mockReturnValue("close");
  mocks.create.mockReturnValue("create");
  mocks.transaction.mockResolvedValue([{ count: 0 }, { id: "pass1" }]);
});

describe("POST /api/capture-passes", () => {
  it("is 401 without a session", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    expect((await POST(req(valid))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "nope"],
    ["an array", []],
    ["an unknown entityType", { entityType: "boat", entityId: "a1" }],
    ["a missing entityType", { entityId: "a1" }],
    ["a missing entityId", { entityType: "gear" }],
    ["a non-string entityId", { entityType: "gear", entityId: 4 }],
    ["an unsafe entityId", { entityType: "gear", entityId: "../x" }],
  ])("is 400 for %s", async (_label, body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is 404 when the item does not exist", async () => {
    mocks.findOwnerName.mockResolvedValue(null);
    expect((await POST(req(valid))).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is 429 over the rate limit, keyed by user", async () => {
    mocks.enforceRateLimit.mockResolvedValue({ allowed: false });
    expect((await POST(req(valid))).status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith({ key: "capture-pass:u:u1", windowMs: 60_000, maxAttempts: 10 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the pass: the token hashes to the stored hash and is not audited", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.path).toBe(`/capture/${body.token}`);
    expect(body.id).toBe("pass1");

    const data = mocks.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ entityType: "ammo", entityId: "a1", createdById: "u1", sessionId: "s1" });
    expect(data.tokenHash).toBe(hashToken(body.token));
    expect(data.tokenHash).not.toBe(body.token);

    expect(mocks.record).toHaveBeenCalledTimes(1);
    const [client, event] = mocks.record.mock.calls[0];
    expect(client).toBeNull();
    expect(event).toMatchObject({
      action: "CAPTURE_PASS_CREATED",
      entityType: "AmmoStock",
      entityId: "a1",
      entityLabel: "9mm Federal",
      changes: { passId: "pass1", expiresAt: body.expiresAt },
    });
    expect(JSON.stringify(event)).not.toContain(body.token);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs only the error class when the database fails, never the token or the message", async () => {
    mocks.transaction.mockRejectedValue(Object.assign(new Error("secret-detail"), { code: "P2002" }));
    const res = await POST(req(valid));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("POST /api/capture-passes failed:", "Error P2002");
  });
});
