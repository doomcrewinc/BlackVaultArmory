import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  del: vi.fn(),
  buildFindMany: vi.fn(),
  buildSlotFindMany: vi.fn(),
  accessoryDeleteMany: vi.fn(),
  linkCount: vi.fn(),
  photoFilesFor: vi.fn(),
  removePhotoFiles: vi.fn(),
}));

const delegate = () => ({ findUnique: mocks.findUnique, delete: mocks.del });

vi.mock("@/lib/prisma", () => {
  const tx = {
    firearm: delegate(),
    buildSlot: { findMany: mocks.buildSlotFindMany, updateMany: vi.fn() },
    accessory: { deleteMany: mocks.accessoryDeleteMany },
  };
  return {
    prisma: {
      firearm: delegate(),
      accessory: delegate(),
      gear: delegate(),
      kit: delegate(),
      ammoStock: delegate(),
      supply: delegate(),
      build: { findMany: mocks.buildFindMany },
      buildSlot: { findMany: mocks.buildSlotFindMany },
      rangeSessionAmmoLink: { count: mocks.linkCount },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({ revalidateDashboardData: vi.fn() }));
vi.mock("@/lib/photos/store", () => ({
  photoFilesFor: mocks.photoFilesFor,
  removePhotoFiles: mocks.removePhotoFiles,
}));

const FILES = [{ id: "p1", fileName: "p1.jpg" }];
const ctx = { params: Promise.resolve({ id: "i1" }) };

const routes = [
  ["firearm", () => import("../firearms/[id]/route"), { firearmId: "i1" }],
  ["accessory", () => import("../accessories/[id]/route"), { accessoryId: "i1" }],
  ["gear", () => import("../gear/[id]/route"), { gearId: "i1" }],
  ["kit", () => import("../kits/[id]/route"), { kitId: "i1" }],
  ["ammo", () => import("../ammo/[id]/route"), { ammoStockId: "i1" }],
  ["supply", () => import("../supplies/[id]/route"), { supplyId: "i1" }],
] as const;

function remove(handler: (r: never, c: typeof ctx) => Promise<Response>, body?: unknown) {
  return handler(
    new Request("http://localhost/api/x/i1", {
      method: "DELETE",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }) as never,
    ctx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.findUnique.mockResolvedValue({ id: "i1" });
  mocks.del.mockResolvedValue({});
  mocks.buildFindMany.mockResolvedValue([]);
  mocks.linkCount.mockResolvedValue(0);
  mocks.photoFilesFor.mockResolvedValue(FILES);
});

describe.each(routes)("DELETE %s removes its photo files", (_type, load, where) => {
  it("collects the files before the delete and removes them after it", async () => {
    const order: string[] = [];
    mocks.photoFilesFor.mockImplementation(async () => (order.push("collect"), FILES));
    mocks.del.mockImplementation(async () => (order.push("delete"), {}));
    mocks.removePhotoFiles.mockImplementation(async () => void order.push("remove"));

    const res = await remove((await load()).DELETE as never);

    expect(res.status).toBe(200);
    expect(mocks.photoFilesFor).toHaveBeenCalledWith(where);
    expect(mocks.removePhotoFiles).toHaveBeenCalledWith(FILES);
    expect(order).toEqual(["collect", "delete", "remove"]);
  });

  it("keeps the files when the delete fails", async () => {
    mocks.del.mockRejectedValue(new Error("db"));

    const res = await remove((await load()).DELETE as never);

    expect(res.status).toBe(500);
    expect(mocks.removePhotoFiles).not.toHaveBeenCalled();
  });

  it("touches no files when the item does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const res = await remove((await load()).DELETE as never);

    expect(res.status).toBe(404);
    expect(mocks.removePhotoFiles).not.toHaveBeenCalled();
  });
});

describe("DELETE firearm with deleteAccessories", () => {
  it("also collects the photos of the accessories it deletes", async () => {
    mocks.buildFindMany.mockResolvedValue([{ id: "b1" }]);
    mocks.buildSlotFindMany.mockResolvedValue([{ accessoryId: "a1" }, { accessoryId: "a2" }]);

    const res = await remove((await import("../firearms/[id]/route")).DELETE as never, {
      deleteAccessories: true,
    });

    expect(res.status).toBe(200);
    expect(mocks.accessoryDeleteMany).toHaveBeenCalled();
    expect(mocks.photoFilesFor).toHaveBeenCalledWith({
      OR: [{ firearmId: "i1" }, { accessoryId: { in: ["a1", "a2"] } }],
    });
  });
});
