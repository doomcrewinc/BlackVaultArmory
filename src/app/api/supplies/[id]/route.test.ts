import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  revalidateDashboardData: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    supply: {
      findUnique: (args: unknown) => mocks.findUnique(args),
      update: (args: unknown) => mocks.update(args),
      delete: (args: unknown) => mocks.delete(args),
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: () => mocks.revalidateDashboardData(),
}));

import { DELETE, GET, PUT } from "./route";

const params = Promise.resolve({ id: "s1" });

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/supplies/s1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stored = {
  id: "s1",
  name: "Hoppe's No. 9",
  category: "CLEANING",
  quantity: 12.5,
  unit: "OZ",
  lowStockAlert: 2,
  notes: "old",
};

describe("PUT /api/supplies/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.update.mockReset().mockResolvedValue({ ...stored });
    mocks.revalidateDashboardData.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("changing only notes leaves quantity, unit, category and dates untouched", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("quantity");
    expect(data).not.toHaveProperty("unit");
    expect(data).not.toHaveProperty("category");
    expect(data).not.toHaveProperty("expirationDate");
    expect(data).not.toHaveProperty("purchaseDate");
    expect(data.notes).toBe("new");
  });

  it("keeps the stored quantity when an emptied field is submitted", async () => {
    await PUT(putRequest({ quantity: "" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.quantity).toBe(12.5);
  });

  it("keeps the stored quantity when the field is explicitly null", async () => {
    await PUT(putRequest({ quantity: null }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("quantity");
  });

  it("stores a real zero quantity rather than treating it as absent", async () => {
    await PUT(putRequest({ quantity: 0 }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.quantity).toBe(0);
  });

  it("stores an unfloored decimal quantity", async () => {
    await PUT(putRequest({ quantity: "3.25" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.quantity).toBe(3.25);
  });

  it("clears lowStockAlert on an explicit null", async () => {
    await PUT(
      putRequest({ lowStockAlert: null }) as never,
      {
        params,
      } as never,
    );
    expect(mocks.update.mock.calls[0][0].data.lowStockAlert).toBeNull();
  });

  it("leaves lowStockAlert untouched when the key is absent", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty(
      "lowStockAlert",
    );
  });

  it("stores a real zero lowStockAlert rather than treating it as absent", async () => {
    await PUT(putRequest({ lowStockAlert: 0 }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.lowStockAlert).toBe(0);
  });

  it("normalizes a submitted category", async () => {
    await PUT(
      putRequest({ category: " medical " }) as never,
      {
        params,
      } as never,
    );
    expect(mocks.update.mock.calls[0][0].data.category).toBe("MEDICAL");
  });

  it("normalizes a submitted unit", async () => {
    await PUT(putRequest({ unit: " gal " }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.unit).toBe("GAL");
  });

  it("404s for a supply that does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PUT(
      putRequest({ notes: "x" }) as never,
      {
        params,
      } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.revalidateDashboardData).not.toHaveBeenCalled();
  });

  it("revalidates the dashboard, whose Supply Alerts widget reads these rows", async () => {
    await PUT(putRequest({ quantity: 1 }) as never, { params } as never);
    expect(mocks.revalidateDashboardData).toHaveBeenCalledTimes(1);
  });

  it("stores a blank purchasePrice as null, not 0", async () => {
    await PUT(putRequest({ purchasePrice: "" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.purchasePrice).toBeNull();
  });

  it("stores a legitimate zero purchasePrice as 0", async () => {
    await PUT(putRequest({ purchasePrice: 0 }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.purchasePrice).toBe(0);
  });

  it("leaves purchasePrice untouched when the body doesn't mention it", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty(
      "purchasePrice",
    );
  });
});

describe("GET and DELETE /api/supplies/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.delete.mockReset().mockResolvedValue(stored);
    mocks.revalidateDashboardData.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns one supply", async () => {
    const response = await GET(
      new Request("http://localhost/api/supplies/s1") as never,
      { params } as never,
    );
    expect(await response.json()).toEqual(stored);
  });

  it("404s a missing supply rather than fetching nothing quietly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/supplies/s1") as never,
      { params } as never,
    );
    expect(response.status).toBe(404);
  });

  it("404s a missing supply rather than deleting nothing quietly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await DELETE(
      new Request("http://localhost/api/supplies/s1") as never,
      { params } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("deletes a supply that exists", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/supplies/s1") as never,
      { params } as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(mocks.revalidateDashboardData).toHaveBeenCalledTimes(1);
  });

  it("does not revalidate the dashboard when there was nothing to delete", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await DELETE(
      new Request("http://localhost/api/supplies/s1") as never,
      {
        params,
      } as never,
    );
    expect(mocks.revalidateDashboardData).not.toHaveBeenCalled();
  });
});
