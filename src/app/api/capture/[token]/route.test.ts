import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findPass: vi.fn(),
  findOwnerName: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/capture/pass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture/pass")>()),
  findPass: mocks.findPass,
}));
vi.mock("@/lib/photos/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/owner")>()),
  findOwnerName: mocks.findOwnerName,
}));

import * as route from "./route";
import { captureThrottle } from "@/lib/capture/throttle";

const TOKEN = "A".repeat(43);
const EXPIRES = new Date("2026-10-04T12:15:00Z");
const pass = {
  id: "pass-1",
  entityType: "gear",
  entityId: "gear-1",
  createdById: "user-1",
  creatorName: "Ann (@ann)",
  expiresAt: EXPIRES,
  uploadCount: 3,
};

function get(token = TOKEN, ip = "10.0.0.1") {
  const request = new NextRequest(`http://localhost/api/capture/${token}`, {
    headers: { "x-forwarded-for": ip },
  });
  return route.GET(request, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TRUSTED_PROXIES = "10.0.0.0/8";
  mocks.findPass.mockResolvedValue({ ok: true, pass });
  mocks.findOwnerName.mockResolvedValue("Plate carrier");
});

describe("GET /api/capture/[token]", () => {
  it("returns exactly the item name, type, expiry and remaining uploads, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["entityType", "expiresAt", "itemName", "remaining"]);
    expect(body).toEqual({
      itemName: "Plate carrier",
      entityType: "gear",
      expiresAt: EXPIRES.toISOString(),
      remaining: 47,
    });
    expect(mocks.findOwnerName).toHaveBeenCalledWith("gear", "gear-1");
  });

  it.each([
    ["expired", "This pass has expired. Make a new one on the computer."],
    ["closed", "This pass was closed. Make a new one on the computer."],
    ["full", "This pass has reached its limit of 50 uploads. Make a new one on the computer."],
  ])("an ended pass (%s) answers 410 with its reason", async (reason, error) => {
    mocks.findPass.mockResolvedValue({ ok: false, reason });
    const res = await get();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error, reason });
  });

  it("an unknown token answers 404 and reveals nothing else", async () => {
    mocks.findPass.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This link is not valid." });
  });

  it("a malformed token answers 404 without a database lookup", async () => {
    const res = await get("short");
    expect(res.status).toBe(404);
    expect(mocks.findPass).not.toHaveBeenCalled();
  });

  it("an item that no longer exists answers 410 closed", async () => {
    mocks.findOwnerName.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(410);
    expect((await res.json()).reason).toBe("closed");
  });

  it("five wrong tokens from one address, then a sixth is throttled with Retry-After", async () => {
    mocks.findPass.mockResolvedValue(null);
    const ip = "10.9.9.9";
    const first = await Promise.all(Array.from({ length: 5 }, () => get(TOKEN, ip)));
    expect(first.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    const sixth = await get(TOKEN, ip);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    captureThrottle.succeed(`ip:${ip}`);
  });

  it("valid tokens never count as failures", async () => {
    const ip = "10.9.9.8";
    const results = await Promise.all(Array.from({ length: 8 }, () => get(TOKEN, ip)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
  });

  it("an ended pass is not a throttle failure", async () => {
    mocks.findPass.mockResolvedValue({ ok: false, reason: "expired" });
    const ip = "10.9.9.7";
    const results = await Promise.all(Array.from({ length: 8 }, () => get(TOKEN, ip)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(410));
  });

  it("with no known client address, wrong tokens are not throttled and a valid token still works", async () => {
    delete process.env.TRUSTED_PROXIES;
    const wrong = await Promise.all(Array.from({ length: 6 }, () => get("short")));
    expect(wrong.map((r) => r.status)).toEqual(Array(6).fill(404));
    expect((await get()).status).toBe(200);
  });

  it("exports only GET", () => {
    expect(Object.keys(route)).toEqual(["GET"]);
  });
});
