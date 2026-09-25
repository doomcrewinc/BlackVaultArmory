import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findMany: vi.fn(),
  create: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    kit: {
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

describe("GET /api/kits", () => {
  beforeEach(() => {
    mocks.findMany.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("orders by name", async () => {
    await GET();
    expect(mocks.findMany.mock.calls[0][0]).toEqual({
      orderBy: { name: "asc" },
    });
  });

  it("500s when the query fails", async () => {
    mocks.findMany.mockRejectedValue(new Error("db down"));
    const response = await GET();
    expect(response.status).toBe(500);
  });
});

describe("POST /api/kits", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ id: "k1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("400s a blank name and never calls create", async () => {
    const response = await POST(
      request("http://localhost/api/kits", { name: "   " }) as never,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("normalizes the category and defaults nullable fields", async () => {
    await POST(
      request("http://localhost/api/kits", {
        name: " Bugout Bag ",
        category: "vehicle",
      }) as never,
    );
    expect(mocks.create.mock.calls[0][0].data).toEqual({
      name: "Bugout Bag",
      category: "VEHICLE",
      location: null,
      notes: null,
      imageUrl: null,
    });
  });

  it("falls back to the default category for junk input", async () => {
    await POST(
      request("http://localhost/api/kits", {
        name: "Range Bag",
        category: "not-a-category",
      }) as never,
    );
    expect(mocks.create.mock.calls[0][0].data.category).toBe("BUGOUT");
  });

  it("returns 201 with the created kit", async () => {
    const response = await POST(
      request("http://localhost/api/kits", { name: "Range Bag" }) as never,
    );
    expect(response.status).toBe(201);
  });
});
