import { beforeEach, describe, expect, it, vi } from "vitest";

const firearmCount = vi.fn();
const accessoryCount = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: { count: (args: unknown) => firearmCount(args) },
    accessory: { count: (args: unknown) => accessoryCount(args) },
  },
}));

import { GET } from "./route";

describe("GET /api/categories/counts", () => {
  beforeEach(() => {
    firearmCount.mockReset().mockResolvedValue(3);
    accessoryCount.mockReset().mockResolvedValue(5);
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

  it("reports the legacy SMG count separately", async () => {
    firearmCount.mockImplementation((args: { where?: { type?: string } }) =>
      Promise.resolve(args?.where?.type === "SMG" ? 2 : 3),
    );
    const body = await (await GET()).json();
    expect(body.legacySmgCount).toBe(2);
  });

  it("answers 503 rather than throwing when the database is down", async () => {
    firearmCount.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const response = await GET();
    expect(response.status).toBe(503);
  });
});
