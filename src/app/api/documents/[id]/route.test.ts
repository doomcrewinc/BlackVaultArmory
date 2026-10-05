import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ requireAuth: async () => null }));
vi.mock("@/lib/prisma", () => ({
  prisma: { document: { findUnique: mocks.findUnique, update: mocks.update } },
}));

import { GET, PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "d1" }) };

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/documents/d1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    ctx,
  );
}

const OWNER_RELATIONS = {
  firearm: { select: { id: true, name: true } },
  accessory: { select: { id: true, name: true } },
  gear: { select: { id: true, name: true } },
  ammoStock: { select: { id: true, caliber: true, brand: true } },
  supply: { select: { id: true, name: true } },
  kit: { select: { id: true, name: true } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ id: "d1" });
  mocks.update.mockResolvedValue({ id: "d1" });
});

describe("GET /api/documents/[id]", () => {
  it("includes every owner relation", async () => {
    await GET(new Request("http://localhost/api/documents/d1") as never, ctx);

    expect(mocks.findUnique.mock.calls[0][0].include).toEqual(OWNER_RELATIONS);
  });
});

describe("PUT /api/documents/[id]", () => {
  it.each(["firearmId", "accessoryId", "gearId", "ammoStockId", "supplyId", "kitId"])(
    "sets and clears %s",
    async (key) => {
      await put({ [key]: "x1" });
      expect(mocks.update.mock.calls[0][0].data).toEqual({ [key]: "x1" });

      await put({ [key]: "" });
      expect(mocks.update.mock.calls[1][0].data).toEqual({ [key]: null });
    },
  );

  it("changes nothing it was not sent", async () => {
    await put({ name: "New" });

    expect(mocks.update.mock.calls[0][0].data).toEqual({ name: "New" });
    expect(mocks.update.mock.calls[0][0].include).toEqual(OWNER_RELATIONS);
  });
});
