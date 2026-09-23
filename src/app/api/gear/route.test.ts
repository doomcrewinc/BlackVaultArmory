import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findMany: vi.fn(),
  create: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gear: {
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

describe("GET /api/gear", () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("applies no category filter without a section", async () => {
    await GET(request("http://localhost/api/gear") as never);
    expect(mocks.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("filters by the section's categories", async () => {
    await GET(request("http://localhost/api/gear?section=knives") as never);
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      category: { in: ["KNIFE"] },
    });
  });

  it("returns nothing for a section that holds no gear", async () => {
    const response = await GET(
      request("http://localhost/api/gear?section=optics") as never,
    );
    expect(await response.json()).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("ignores an unknown slug rather than failing", async () => {
    await GET(request("http://localhost/api/gear?section=nonsense") as never);
    expect(mocks.findMany.mock.calls[0][0].where).toBeUndefined();
  });
});

describe("POST /api/gear", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ id: "g1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("requires a name", async () => {
    const response = await POST(
      request("http://localhost/api/gear", { category: "KNIFE" }) as never,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("stores a normalized category and a floored quantity", async () => {
    await POST(
      request("http://localhost/api/gear", {
        name: "Benchmade Bugout",
        category: " case ",
        quantity: "3",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.category).toBe("CASE");
    expect(data.quantity).toBe(3);
  });

  it("defaults an unknown category and a missing quantity", async () => {
    await POST(
      request("http://localhost/api/gear", {
        name: "Mystery",
        category: "ZZ",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.category).toBe("KNIFE");
    expect(data.quantity).toBe(1);
  });
});
