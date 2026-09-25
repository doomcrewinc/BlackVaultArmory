import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gear: {
      findUnique: (args: unknown) => mocks.findUnique(args),
      update: (args: unknown) => mocks.update(args),
      delete: (args: unknown) => mocks.delete(args),
    },
  },
}));

import { DELETE, GET, PUT } from "./route";

const params = Promise.resolve({ id: "g1" });

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/gear/g1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stored = {
  id: "g1",
  name: "Bugout",
  category: "KNIFE",
  quantity: 12,
  notes: "old",
  protectionLevel: null,
  armorSize: null,
};

const storedArmor = {
  ...stored,
  category: "ARMOR",
  protectionLevel: "IIIA",
  armorSize: "M SAPI",
};

describe("PUT /api/gear/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.update.mockReset().mockResolvedValue({ ...stored });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("keeps the stored quantity when the field is absent", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("quantity");
  });

  it("keeps the stored quantity when an emptied field is submitted", async () => {
    await PUT(putRequest({ quantity: "" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.quantity).toBe(12);
  });

  it("keeps the stored category when the field is absent", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("category");
  });

  it("normalizes a submitted category", async () => {
    await PUT(putRequest({ category: " case " }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.category).toBe("CASE");
  });

  it("404s for gear that does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PUT(
      putRequest({ notes: "x" }) as never,
      { params } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clears the armor fields when only category moves off armor, even though the body never mentions them", async () => {
    mocks.findUnique.mockResolvedValue(storedArmor);
    await PUT(putRequest({ category: "TOOL" }) as never, { params } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.protectionLevel).toBeNull();
    expect(data.armorSize).toBeNull();
  });

  it("clears expirationDate when sent blank", async () => {
    await PUT(putRequest({ expirationDate: "" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.expirationDate).toBeNull();
  });

  it("400s on a malformed expirationDate instead of 500ing", async () => {
    const response = await PUT(
      putRequest({ expirationDate: "not-a-date" }) as never,
      { params } as never,
    );
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("stores a whitespace-only purchase price as null, not 0", async () => {
    await PUT(putRequest({ purchasePrice: "   " }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.purchasePrice).toBeNull();
  });
});

describe("GET and DELETE /api/gear/[id]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stored);
    mocks.delete.mockReset().mockResolvedValue(stored);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns one item with its documents", async () => {
    await GET(
      new Request("http://localhost/api/gear/g1") as never,
      { params } as never,
    );
    expect(mocks.findUnique.mock.calls[0][0].include).toHaveProperty(
      "documents",
    );
  });

  it("404s a missing item rather than deleting nothing quietly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await DELETE(
      new Request("http://localhost/api/gear/g1") as never,
      {
        params,
      } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
