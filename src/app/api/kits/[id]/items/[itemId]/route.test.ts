import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    kitItem: {
      findUnique: (args: unknown) => mocks.findUnique(args),
      update: (args: unknown) => mocks.update(args),
      delete: (args: unknown) => mocks.delete(args),
    },
  },
}));

import { DELETE, PUT } from "./route";

const params = Promise.resolve({ id: "k1", itemId: "ki1" });

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/kits/k1/items/ki1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const storedGearLine = {
  id: "ki1",
  kitId: "k1",
  gearId: "g1",
  supplyId: null,
  accessoryId: null,
  ammoStockId: null,
  firearmId: null,
  label: null,
  quantity: 4,
  targetQuantity: 6,
  notes: "old",
};

const storedLabelLine = {
  id: "ki1",
  kitId: "k1",
  gearId: null,
  supplyId: null,
  accessoryId: null,
  ammoStockId: null,
  firearmId: null,
  label: "spare keys",
  quantity: 1,
  targetQuantity: null,
  notes: null,
};

describe("PUT /api/kits/[id]/items/[itemId]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(storedGearLine);
    mocks.update.mockReset().mockResolvedValue({ ...storedGearLine });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("404s for a line that does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await PUT(putRequest({ notes: "x" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  // THE CROSS-KIT GUARD. `findUnique({ where: { id: itemId } })` answers for
  // any line in the database, so before this check a PUT to
  // /api/kits/<other-kit>/items/ki1 edited a line out of a DIFFERENT bag and
  // answered 200. The stored line below belongs to "k1" while the path names
  // "k99"; 404 and "never wrote" are asserted SEPARATELY, because a route that
  // 404s after having already called update is still the bug.
  it("404s when the line belongs to a different kit, and never calls update", async () => {
    const response = await PUT(putRequest({ notes: "x" }) as never, {
      params: Promise.resolve({ id: "k99", itemId: "ki1" }),
    } as never);
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still updates a line whose kitId matches the path", async () => {
    const response = await PUT(putRequest({ notes: "x" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalled();
  });

  // Test 4: the merged-record case. The body alone (`{ supplyId: "s1" }`)
  // looks like a valid single-source update; only merging it with the
  // stored gearId reveals the conflict.
  it("400s setting supplyId on a stored gearId line, and never calls update", async () => {
    const response = await PUT(putRequest({ supplyId: "s1" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("multiple-sources");
    expect(payload.fields.sort()).toEqual(["gearId", "supplyId"]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("400s setting a label on a stored gearId line", async () => {
    const response = await PUT(
      putRequest({ label: "spare" }) as never,
      { params } as never,
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("source-and-label");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows switching sources when the old one is explicitly cleared", async () => {
    await PUT(
      putRequest({ gearId: null, supplyId: "s1" }) as never,
      { params } as never,
    );
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.supplyId).toBe("s1");
    expect(data.gearId).toBeNull();
    expect(data.accessoryId).toBeNull();
    expect(data.ammoStockId).toBeNull();
    expect(data.firearmId).toBeNull();
    expect(data.label).toBeNull();
  });

  it("keeps the stored source when the body only touches quantity", async () => {
    await PUT(putRequest({ quantity: 5 }) as never, { params } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.gearId).toBe("g1");
    expect(data.supplyId).toBeNull();
  });

  it("clearing the only source down to nothing requires a label (no-source)", async () => {
    const response = await PUT(putRequest({ gearId: null }) as never, {
      params,
    } as never);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("no-source");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clearing a source while supplying a label succeeds", async () => {
    await PUT(
      putRequest({ gearId: null, label: "loose batteries" }) as never,
      { params } as never,
    );
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.gearId).toBeNull();
    expect(data.label).toBe("loose batteries");
  });

  // Test 5: quantity: "" preserves the stored quantity rather than
  // resetting it to the schema default of 1.
  it('preserves the stored quantity when quantity is ""', async () => {
    await PUT(putRequest({ quantity: "" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data.quantity).toBe(4);
  });

  it("keeps the stored quantity when the field is absent", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("quantity");
  });

  it("treats an explicit null quantity as absent, preserving the stored value", async () => {
    await PUT(putRequest({ quantity: null }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("quantity");
  });

  it("clears targetQuantity when sent explicit null", async () => {
    await PUT(putRequest({ targetQuantity: null }) as never, {
      params,
    } as never);
    expect(mocks.update.mock.calls[0][0].data.targetQuantity).toBeNull();
  });

  it("keeps the stored targetQuantity when the field is absent", async () => {
    await PUT(putRequest({ notes: "new" }) as never, { params } as never);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty(
      "targetQuantity",
    );
  });

  it("allows editing notes on a label-only line without disturbing the label", async () => {
    mocks.findUnique.mockResolvedValue(storedLabelLine);
    await PUT(putRequest({ notes: "restocked" }) as never, {
      params,
    } as never);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.label).toBe("spare keys");
    expect(data.notes).toBe("restocked");
  });
});

describe("DELETE /api/kits/[id]/items/[itemId]", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(storedGearLine);
    mocks.delete.mockReset().mockResolvedValue(storedGearLine);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("404s a missing line rather than deleting nothing quietly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await DELETE(
      new Request("http://localhost/api/kits/k1/items/ki1") as never,
      { params } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("deletes the line by id", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/kits/k1/items/ki1") as never,
      { params } as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.delete).toHaveBeenCalledWith({ where: { id: "ki1" } });
  });

  // The same cross-kit guard on the destructive verb, which is where it
  // matters most: DELETE /api/kits/<other-kit>/items/ki1 removed a line from a
  // bag the caller never named and returned { success: true }. 404 and "never
  // deleted" are separate assertions.
  it("404s when the line belongs to a different kit, and never calls delete", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/kits/k99/items/ki1") as never,
      { params: Promise.resolve({ id: "k99", itemId: "ki1" }) } as never,
    );
    expect(response.status).toBe(404);
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
