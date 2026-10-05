import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPass: vi.fn(),
  getClientIp: vi.fn(),
  valid: null as unknown,
}));

vi.mock("./pass", () => ({
  PASS_MAX_UPLOADS: 30,
  findPass: mocks.findPass,
  returnSlot: vi.fn(),
  takeSlot: vi.fn(),
  uploadCountOf: vi.fn(),
}));
vi.mock("@/lib/server/client-ip", () => ({ getClientIp: mocks.getClientIp }));
vi.mock("@/lib/documents/store", () => ({ storeDocument: vi.fn() }));
vi.mock("@/lib/photos/store", () => ({ addPhoto: vi.fn(), normaliseLabel: vi.fn() }));
vi.mock("@/lib/photos/owner", () => ({ OWNER_COLUMN: {}, findOwnerName: vi.fn() }));
// The throttle reads the clock through a function, so the fake clock applies.
vi.mock("./throttle", async () => {
  const { createThrottle } = await import("@/lib/auth/throttle");
  return { captureThrottle: createThrottle({ now: () => Date.now() }) };
});
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: vi.fn() }));

import { captureThrottle } from "./throttle";
import { resolvePass } from "./upload";

const request = new Request("http://localhost/api/capture/x");
const GOOD = "A".repeat(32);
const BAD = "B".repeat(32);
const OPEN = { ok: true, pass: { id: "p1" } };
const ENDED = { ok: false, reason: "expired" };

async function status(token: string): Promise<number> {
  const result = await resolvePass(request, token);
  return result.ok ? 200 : result.status;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  mocks.getClientIp.mockReturnValue("203.0.113.9");
  mocks.findPass.mockImplementation(async (token: string) => (token === GOOD ? mocks.valid : null));
});

afterEach(() => {
  captureThrottle.succeed("ip:203.0.113.9");
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("capture wrong-token throttle", () => {
  it.each([
    ["an open pass", OPEN, 200],
    ["an ended pass", ENDED, 410],
  ] as const)("forgets earlier wrong links after %s is used", async (_name, valid, expected) => {
    mocks.valid = valid;
    const before = [];
    for (let i = 0; i < 5; i++) before.push(await status(BAD));
    expect(before).toEqual([404, 404, 404, 404, 404]);

    vi.advanceTimersByTime(2000);
    expect(await status(GOOD)).toBe(expected);

    const after = [];
    for (let i = 0; i < 5; i++) after.push(await status(BAD));
    expect(after).toEqual([404, 404, 404, 404, 404]);
  });

  it("does throttle an address that keeps sending wrong links", async () => {
    mocks.valid = OPEN;
    const codes = [];
    for (let i = 0; i < 7; i++) {
      codes.push(await status(BAD));
    }
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes).toContain(429);
  });

  it("throttles an address with a port under the same key as the bare address", async () => {
    mocks.valid = OPEN;
    mocks.getClientIp.mockReturnValue("203.0.113.9:5678");
    for (let i = 0; i < 7; i++) await status(BAD);
    mocks.getClientIp.mockReturnValue("203.0.113.9");
    expect(await status(BAD)).toBe(429);
  });

  it("does no throttling when the address is not an IP address", async () => {
    mocks.valid = OPEN;
    mocks.getClientIp.mockReturnValue("../x");
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push(await status(BAD));
    expect(new Set(codes)).toEqual(new Set([404]));
  });

  it("does no throttling when the address is not known", async () => {
    mocks.valid = OPEN;
    mocks.getClientIp.mockReturnValue(null);
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push(await status(BAD));
    expect(new Set(codes)).toEqual(new Set([404]));
    expect(await status(GOOD)).toBe(200);
  });
});
