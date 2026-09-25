import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  // Every OTHER delegate's delete, mocked purely so the "deleting a kit
  // touches no inventory" test can assert none of them were ever called.
  // A cascade pointed the wrong way would delete a firearm when someone
  // deletes a bag — this is the guard for that.
  kitItemDelete: vi.fn(),
  gearDelete: vi.fn(),
  supplyDelete: vi.fn(),
  accessoryDelete: vi.fn(),
  ammoStockDelete: vi.fn(),
  firearmDelete: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    kit: {
      findUnique: (args: unknown) => mocks.findUnique(args),
      update: (args: unknown) => mocks.update(args),
      delete: (args: unknown) => mocks.delete(args),
    },
    kitItem: { delete: (args: unknown) => mocks.kitItemDelete(args) },
    gear: { delete: (args: unknown) => mocks.gearDelete(args) },
    supply: { delete: (args: unknown) => mocks.supplyDelete(args) },
    accessory: { delete: (args: unknown) => mocks.accessoryDelete(args) },
    ammoStock: { delete: (args: unknown) => mocks.ammoStockDelete(args) },
    firearm: { delete: (args: unknown) => mocks.firearmDelete(args) },
  },
}));

import { DELETE, GET, PUT } from "./route";

const params = Promise.resolve({ id: "k1" });

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/kits/k1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stored = {
  id: "k1",
  name: "Bugout Bag",
  category: "BUGOUT",
  location: "Garage",
  notes: "old",
  imageUrl: null,
};

describe("GET /api/kits/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("includes all five source relations", async () => {
    await GET(new Request("http://localhost/api/kits/k1") as never, {
      params,
    } as never);
    expect(mocks.findUnique.mock.calls[0][0].include).toEqual({
      items: {
        include: {
          gear: true,
          supply: true,
          accessory: true,
          ammoStock: true,
          firearm: true,
        },
      },
    });
  });

  it("404s a missing kit", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/kits/k1") as never,
      { params } as never,
    );
    expect(response.status).toBe(404);
  });
});

describe("PUT /api/kits/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.update.mockReset().mockResolvedValue({ ...stored });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("keeps the stored category when the field is absent", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("category");
  });

  it("normalizes a submitted category", async () => {
    await PUT(putRequest({ category: " medical " }) as never, {
      params,
    } as never);
    expect(mocks.update.mock.calls[0][0].data.category).toBe("MEDICAL");
  });

  it("treats an explicit null category as absent, preserving the stored value", async () => {
    await PUT(putRequest({ category: null }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("category");
  });

  it("404s for a kit that does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PUT(putRequest({ notes: "x" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/kits/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.delete.mockReset().mockResolvedValue(stored);
    mocks.kitItemDelete.mockReset();
    mocks.gearDelete.mockReset();
    mocks.supplyDelete.mockReset();
    mocks.accessoryDelete.mockReset();
    mocks.ammoStockDelete.mockReset();
    mocks.firearmDelete.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("404s a missing kit rather than deleting nothing quietly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await DELETE(
      new Request("http://localhost/api/kits/k1") as never,
      { params } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  // Spec guarantee: "Deleting a kit removes its lines and touches no
  // inventory." The database's own onDelete: Cascade on KitItem.kitId does
  // the line removal; this route calls prisma.kit.delete and NOTHING else.
  // A cascade misconfigured in the other direction — or a route that
  // manually deletes the lines' targets — would delete a firearm just
  // because it was packed in a bag.
  it("deletes only the kit — no inventory delegate's delete is called", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/kits/k1") as never,
      { params } as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.delete).toHaveBeenCalledWith({ where: { id: "k1" } });
    expect(mocks.kitItemDelete).not.toHaveBeenCalled();
    expect(mocks.gearDelete).not.toHaveBeenCalled();
    expect(mocks.supplyDelete).not.toHaveBeenCalled();
    expect(mocks.accessoryDelete).not.toHaveBeenCalled();
    expect(mocks.ammoStockDelete).not.toHaveBeenCalled();
    expect(mocks.firearmDelete).not.toHaveBeenCalled();
  });
});
