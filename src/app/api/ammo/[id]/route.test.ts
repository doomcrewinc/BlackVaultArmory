import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findUnique: vi.fn(),
  update: vi.fn(),
  revalidateDashboardData: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ammoStock: {
      findUnique: (args: unknown) => mocks.findUnique(args),
      update: (args: unknown) => mocks.update(args),
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: () => mocks.revalidateDashboardData(),
}));

import { PUT } from "./route";

const params = Promise.resolve({ id: "a1" });

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/ammo/a1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stored = {
  id: "a1",
  caliber: "9mm",
  brand: "Federal",
  quantity: 500,
  purchasePrice: 150,
  pricePerRound: 0.3,
};

describe("PUT /api/ammo/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.update.mockReset().mockResolvedValue({ ...stored });
    mocks.revalidateDashboardData.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stores a blank purchasePrice and pricePerRound as null, not 0", async () => {
    await PUT(putRequest({ purchasePrice: "", pricePerRound: "   " }) as never, {
      params,
    } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.purchasePrice).toBeNull();
    expect(data.pricePerRound).toBeNull();
  });

  it("stores a legitimate zero purchasePrice and pricePerRound as 0", async () => {
    await PUT(putRequest({ purchasePrice: 0, pricePerRound: 0 }) as never, {
      params,
    } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.purchasePrice).toBe(0);
    expect(data.pricePerRound).toBe(0);
  });

  it("leaves purchasePrice and pricePerRound untouched when the body doesn't mention them", async () => {
    await PUT(putRequest({ brand: "Winchester" }) as never, {
      params,
    } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("purchasePrice");
    expect(data).not.toHaveProperty("pricePerRound");
  });

  it("404s a missing stock rather than updating nothing quietly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PUT(putRequest({ purchasePrice: 10 }) as never, {
      params,
    } as never);
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
