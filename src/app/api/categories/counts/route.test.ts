import { beforeEach, describe, expect, it, vi } from "vitest";

const firearmCount = vi.fn();
const accessoryCount = vi.fn();

// Every count goes through here so the test can watch how many are in flight.
let inFlight = 0;
let maxInFlight = 0;
async function tracked<T>(result: Promise<T>): Promise<T> {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    // A microtask boundary, so concurrent callers would overlap here.
    await Promise.resolve();
    return await result;
  } finally {
    inFlight -= 1;
  }
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: { count: (args: unknown) => tracked(firearmCount(args)) },
    accessory: { count: (args: unknown) => tracked(accessoryCount(args)) },
  },
}));

import { GET } from "./route";

describe("GET /api/categories/counts", () => {
  beforeEach(() => {
    firearmCount.mockReset().mockResolvedValue(3);
    accessoryCount.mockReset().mockResolvedValue(5);
    inFlight = 0;
    maxInFlight = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns a count for every section slug", async () => {
    const body = await (await GET()).json();
    const { CATEGORY_SECTIONS } = await import("@/lib/categories");
    for (const section of CATEGORY_SECTIONS) {
      expect(body.counts[section.slug]).toBeTypeOf("number");
    }
  });

  it("counts firearms for vault sections and accessories for gear sections", async () => {
    const body = await (await GET()).json();
    expect(body.counts.handguns).toBe(3);
    expect(body.counts.optics).toBe(5);
  });

  it("reports the legacy SMG count separately, unclassified rows only", async () => {
    firearmCount.mockImplementation(
      (args: { where?: { type?: string; nfaClass?: string } }) =>
        Promise.resolve(
          args?.where?.type === "SMG" && args?.where?.nfaClass === "NONE"
            ? 2
            : 3,
        ),
    );
    const body = await (await GET()).json();
    expect(body.legacySmgCount).toBe(2);
  });

  it("queries sequentially, never concurrently (SQLite connection_limit=1)", async () => {
    await GET();

    expect(firearmCount.mock.calls.length).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });

  it("answers 503 rather than throwing when the database is down", async () => {
    firearmCount.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const response = await GET();
    expect(response.status).toBe(503);
  });
});
