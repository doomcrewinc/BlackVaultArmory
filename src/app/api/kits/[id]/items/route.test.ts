import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  kitFindUnique: vi.fn(),
  create: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    kit: {
      findUnique: (args: unknown) => mocks.kitFindUnique(args),
    },
    kitItem: {
      create: (args: unknown) => mocks.create(args),
    },
  },
}));

import { POST } from "./route";

const params = Promise.resolve({ id: "k1" });

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/kits/k1/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/kits/[id]/items", () => {
  beforeEach(() => {
    mocks.kitFindUnique.mockReset().mockResolvedValue({ id: "k1" });
    mocks.create.mockReset().mockResolvedValue({ id: "ki1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("404s when the kit does not exist", async () => {
    mocks.kitFindUnique.mockResolvedValue(null);
    const response = await POST(postRequest({ gearId: "g1" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Test 1: two foreign keys → 400, create never called.
  it("400s a line with two foreign keys, and never calls create", async () => {
    const response = await POST(
      postRequest({ gearId: "g1", supplyId: "s1" }) as never,
      { params } as never,
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("multiple-sources");
    expect(payload.fields).toEqual(["gearId", "supplyId"]);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Test 2: a foreign key and a label → 400.
  it("400s a line with a foreign key and a label", async () => {
    const response = await POST(
      postRequest({ gearId: "g1", label: "spare" }) as never,
      { params } as never,
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("source-and-label");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("400s a line with no source and no label", async () => {
    const response = await POST(postRequest({}) as never, {
      params,
    } as never);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("no-source");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  // Test 3: a label-only line → 201 with all five FKs null.
  it("201s a label-only line with all five FKs explicitly null", async () => {
    const response = await POST(
      postRequest({ label: "spare batteries", quantity: 3 }) as never,
      { params } as never,
    );
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data).toEqual({
      kitId: "k1",
      gearId: null,
      supplyId: null,
      accessoryId: null,
      ammoStockId: null,
      firearmId: null,
      label: "spare batteries",
      quantity: 3,
      targetQuantity: null,
      notes: null,
    });
  });

  it("accepts a single foreign key and stores it on the matching column", async () => {
    await POST(postRequest({ ammoStockId: "a1" }) as never, {
      params,
    } as never);
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.ammoStockId).toBe("a1");
    expect(data.gearId).toBeNull();
    expect(data.supplyId).toBeNull();
    expect(data.accessoryId).toBeNull();
    expect(data.firearmId).toBeNull();
    expect(data.label).toBeNull();
  });

  it("defaults quantity to 1 when absent, matching the schema default", async () => {
    await POST(postRequest({ gearId: "g1" }) as never, { params } as never);
    expect(mocks.create.mock.calls[0][0].data.quantity).toBe(1);
  });

  it("normalizes a decimal quantity without flooring it", async () => {
    await POST(postRequest({ gearId: "g1", quantity: 2.5 }) as never, {
      params,
    } as never);
    expect(mocks.create.mock.calls[0][0].data.quantity).toBe(2.5);
  });

  it("accepts a nullable targetQuantity", async () => {
    await POST(
      postRequest({ gearId: "g1", targetQuantity: 10 }) as never,
      { params } as never,
    );
    expect(mocks.create.mock.calls[0][0].data.targetQuantity).toBe(10);
  });
});
