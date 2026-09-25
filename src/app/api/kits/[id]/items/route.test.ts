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
import { KIT_ITEM_SOURCE_LABELS } from "@/lib/kit";

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

  // A STALE SOURCE ID IS A BAD REQUEST. Before this, the FK constraint fell
  // into the generic catch and answered 500 "Failed to add kit item", which
  // reads as an outage for what is a tab left open across a delete.
  it("400s a stale foreign key rather than 500ing, and names the field", async () => {
    mocks.create.mockRejectedValue(
      Object.assign(new Error("FK constraint failed"), { code: "P2003" }),
    );
    const response = await POST(postRequest({ gearId: "gone" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(400);
    const payload = await response.json();
    // The message must name WHICH source, or the user cannot tell which of the
    // five pickers to re-open.
    expect(payload.error).toContain("Gear");
    expect(payload.fields).toEqual(["gearId"]);
  });

  it("names the right source kind for a stale key on another table", async () => {
    // Derived from the route's own label map, so a renamed label cannot leave
    // this test asserting a string the route no longer produces.
    mocks.create.mockRejectedValue(
      Object.assign(new Error("FK constraint failed"), { code: "P2003" }),
    );
    const response = await POST(postRequest({ firearmId: "gone" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toContain(KIT_ITEM_SOURCE_LABELS.firearmId);
    expect(payload.fields).toEqual(["firearmId"]);
  });

  it("still 500s a failure that is not a foreign-key violation", async () => {
    // The guard must translate ONE code, not swallow every write failure into
    // a 400 — a disk-full or a locked database is genuinely a server fault.
    mocks.create.mockRejectedValue(
      Object.assign(new Error("database is locked"), { code: "P2024" }),
    );
    const response = await POST(postRequest({ gearId: "g1" }) as never, {
      params,
    } as never);
    expect(response.status).toBe(500);
  });
});
