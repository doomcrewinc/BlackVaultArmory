import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findMany: vi.fn(),
  create: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    supply: {
      findMany: (args: unknown) => mocks.findMany(args),
      create: (args: unknown) => mocks.create(args),
    },
  },
}));

import { GET, POST } from "./route";

function request(url: string, body?: unknown): Request {
  return body === undefined
    ? new Request(url)
    : new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
}

describe("GET /api/supplies", () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("applies no category filter without a section", async () => {
    await GET(request("http://localhost/api/supplies") as never);
    expect(mocks.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("filters by the cleaning section's category", async () => {
    await GET(
      request("http://localhost/api/supplies?section=cleaning") as never,
    );
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      category: { in: ["CLEANING"] },
    });
  });

  it("filters by the medical section's category", async () => {
    await GET(
      request("http://localhost/api/supplies?section=medical") as never,
    );
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      category: { in: ["MEDICAL"] },
    });
  });

  it("filters by food-water's explicit categories plus its catch-all", async () => {
    await GET(
      request("http://localhost/api/supplies?section=food-water") as never,
    );
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      category: { notIn: ["CLEANING", "MEDICAL"] },
    });
  });

  it("returns nothing for a registered section with no supply source", async () => {
    const response = await GET(
      request("http://localhost/api/supplies?section=optics") as never,
    );
    expect(await response.json()).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("ignores an unknown slug rather than failing", async () => {
    await GET(
      request("http://localhost/api/supplies?section=nonsense") as never,
    );
    expect(mocks.findMany.mock.calls[0][0].where).toBeUndefined();
  });
});

describe("POST /api/supplies", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ id: "s1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("requires a name", async () => {
    const response = await POST(
      request("http://localhost/api/supplies", {
        category: "CLEANING",
      }) as never,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("normalizes category and unit and stores a decimal quantity unfloored", async () => {
    await POST(
      request("http://localhost/api/supplies", {
        name: "Hoppe's No. 9",
        category: " cleaning ",
        unit: " oz ",
        quantity: "12.5",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.category).toBe("CLEANING");
    expect(data.unit).toBe("OZ");
    expect(data.quantity).toBe(12.5);
  });

  it("defaults a missing quantity to 0", async () => {
    await POST(
      request("http://localhost/api/supplies", {
        name: "Bandages",
        category: "MEDICAL",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.quantity).toBe(0);
  });

  it("defaults an unknown category and unit", async () => {
    await POST(
      request("http://localhost/api/supplies", {
        name: "Mystery",
        category: "ZZ",
        unit: "ZZ",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.category).toBe("OTHER");
    expect(data.unit).toBe("COUNT");
  });
});
