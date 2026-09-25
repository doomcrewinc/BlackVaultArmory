import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findMany: vi.fn(),
  create: vi.fn(),
  revalidateDashboardData: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    supply: {
      findMany: (args: unknown) => mocks.findMany(args),
      create: (args: unknown) => mocks.create(args),
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: () => mocks.revalidateDashboardData(),
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

  it("filters by the food-water section's categories", async () => {
    await GET(
      request("http://localhost/api/supplies?section=food-water") as never,
    );
    // Phase 5 gave food-water its own explicit category list and moved the
    // supply catch-all to other-prep, so this is a bare `in` fragment again
    // rather than the `{ OR: [...] }` it carried while it doubled as the
    // catch-all's home.
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      category: { in: ["FOOD", "WATER", "FILTER"] },
    });
  });

  it("filters by other-prep's explicit categories plus its catch-all", async () => {
    await GET(
      request("http://localhost/api/supplies?section=other-prep") as never,
    );
    // other-prep carries two supply matchers (an explicit `in` for
    // SANITATION/CBRN_FILTER/OTHER plus a catch-all `notIn` for everything
    // else) — the same shape food-water used to carry before phase 5 gave
    // the catch-all its own home — so supplyWhereForSection wraps them in
    // `{ OR: [...] }`.
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { category: { in: ["SANITATION", "CBRN_FILTER", "OTHER"] } },
        {
          category: {
            notIn: [
              "CLEANING",
              "MEDICAL",
              "FOOD",
              "WATER",
              "FILTER",
              "BATTERY",
              "FUEL",
              "SIGNAL",
              "SANITATION",
              "CBRN_FILTER",
              "OTHER",
            ],
          },
        },
      ],
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
    mocks.revalidateDashboardData.mockReset();
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

  it("revalidates the dashboard, whose Supply Alerts widget reads these rows", async () => {
    await POST(
      request("http://localhost/api/supplies", {
        name: "Bandages",
        category: "MEDICAL",
      }) as never,
    );
    expect(mocks.revalidateDashboardData).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate when the write was rejected", async () => {
    await POST(request("http://localhost/api/supplies", {}) as never);
    expect(mocks.revalidateDashboardData).not.toHaveBeenCalled();
  });

  it("stores a blank purchasePrice as null, not 0", async () => {
    await POST(
      request("http://localhost/api/supplies", {
        name: "Bandages",
        category: "MEDICAL",
        purchasePrice: "",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.purchasePrice).toBeNull();
  });

  it("stores a legitimate zero purchasePrice as 0", async () => {
    await POST(
      request("http://localhost/api/supplies", {
        name: "Bandages",
        category: "MEDICAL",
        purchasePrice: 0,
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.purchasePrice).toBe(0);
  });
});
