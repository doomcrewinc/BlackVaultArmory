import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  photoFindUnique: vi.fn(),
  photoUpdate: vi.fn(),
  photoDelete: vi.fn(),
  itemFindUnique: vi.fn(),
  itemUpdate: vi.fn(),
  removePhotoFiles: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/prisma", () => {
  const client = {
    photo: { findUnique: mocks.photoFindUnique, update: mocks.photoUpdate, delete: mocks.photoDelete },
    gear: { findUnique: mocks.itemFindUnique, update: mocks.itemUpdate },
  };
  return {
    prisma: { ...client, $transaction: async (fn: (t: typeof client) => Promise<unknown>) => fn(client) },
  };
});
vi.mock("@/lib/photos/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/store")>()),
  removePhotoFiles: mocks.removePhotoFiles,
}));

import { DELETE, PATCH } from "./route";

const row = {
  id: "p1",
  fileName: "p1.jpg",
  fileSize: 4,
  width: 2,
  height: 2,
  label: null,
  viaPass: false,
  createdAt: new Date("2026-10-04T00:00:00Z"),
  firearmId: null,
  accessoryId: null,
  gearId: "g1",
  kitId: null,
  ammoStockId: null,
  supplyId: null,
};
const boom = Object.assign(new Error("MARKER-secret"), { code: "ENOSPC" });
const ctx = { params: Promise.resolve({ id: "p1" }) };

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/photos/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    ctx,
  );
}

const del = () => DELETE(new Request("http://localhost/api/photos/p1", { method: "DELETE" }) as never, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireAuth.mockResolvedValue(null);
  mocks.photoFindUnique.mockResolvedValue(row);
  mocks.photoUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...row, ...data }));
  mocks.itemFindUnique.mockResolvedValue({ imageUrl: null });
});

describe.each([
  ["PATCH", () => patch({ label: "x" })],
  ["DELETE", del],
])("%s /api/photos/[id] guards", (_name, call) => {
  it("is refused without a session", async () => {
    mocks.requireAuth.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }));
    expect((await call()).status).toBe(401);
  });

  it("404s when the photo does not exist", async () => {
    mocks.photoFindUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});

describe("failure logging", () => {
  it.each([
    ["PATCH", () => patch({ label: "x" }), () => mocks.photoUpdate.mockRejectedValueOnce(boom)],
    ["DELETE", del, () => mocks.photoDelete.mockRejectedValueOnce(boom)],
  ])("%s logs the error name and code, not its message", async (_n, call, fail) => {
    fail();

    expect((await call()).status).toBe(500);

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("Error ENOSPC");
    expect(logged).not.toContain("MARKER-secret");
  });
});

describe("PATCH /api/photos/[id] input handling", () => {
  it.each([[null], [5], ["x"], [[]]])("400s on the body %j", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid request body.");
    expect(mocks.photoUpdate).not.toHaveBeenCalled();
  });

  it.each([[5], [true], [{}], [["a"]]])("400s on the label %j without updating", async (label) => {
    expect((await patch({ label })).status).toBe(400);
    expect(mocks.photoUpdate).not.toHaveBeenCalled();
  });

  it.each([[null], [""]])("still clears the label with %j", async (label) => {
    expect((await patch({ label })).status).toBe(200);
    expect(mocks.photoUpdate.mock.calls[0][0].data).toEqual({ label: null });
  });
});

describe("PATCH /api/photos/[id]", () => {
  it("normalises the label", async () => {
    const res = await patch({ label: "  side " });
    expect(mocks.photoUpdate.mock.calls[0][0].data).toEqual({ label: "side" });
    expect((await res.json()).photo.label).toBe("side");
  });

  it("clears the label with null", async () => {
    await patch({ label: null });
    expect(mocks.photoUpdate.mock.calls[0][0].data).toEqual({ label: null });
  });

  it("400s on a label over 80 characters", async () => {
    expect((await patch({ label: "x".repeat(81) })).status).toBe(400);
    expect(mocks.photoUpdate).not.toHaveBeenCalled();
  });

  it("main true sets the owner's imageUrl and reports isMain", async () => {
    mocks.itemUpdate.mockImplementation(async ({ data }: { data: { imageUrl: string } }) => {
      mocks.itemFindUnique.mockResolvedValue({ imageUrl: data.imageUrl });
    });
    const res = await patch({ main: true });

    expect(mocks.itemUpdate).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { imageUrl: "/uploads/images/photos/p1.jpg" },
    });
    expect((await res.json()).photo.isMain).toBe(true);
  });

  it("leaves the item alone when main is not requested", async () => {
    await patch({ label: "x" });
    expect(mocks.itemUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/photos/[id]", () => {
  it("clears the item's imageUrl when the photo was the main picture", async () => {
    mocks.itemFindUnique.mockResolvedValue({ imageUrl: "/uploads/images/photos/p1.jpg" });

    const res = await del();

    expect(mocks.photoDelete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(mocks.itemUpdate).toHaveBeenCalledWith({ where: { id: "g1" }, data: { imageUrl: null } });
    expect(mocks.removePhotoFiles).toHaveBeenCalledWith([{ id: "p1", fileName: "p1.jpg" }]);
    expect(await res.json()).toEqual({ success: true });
  });

  it("leaves the imageUrl alone for another photo", async () => {
    mocks.itemFindUnique.mockResolvedValue({ imageUrl: "/uploads/images/photos/other.jpg" });

    await del();

    expect(mocks.itemUpdate).not.toHaveBeenCalled();
    expect(mocks.removePhotoFiles).toHaveBeenCalled();
  });

  it("keeps the files when the delete fails", async () => {
    mocks.photoDelete.mockRejectedValue(new Error("db"));
    expect((await del()).status).toBe(500);
    expect(mocks.removePhotoFiles).not.toHaveBeenCalled();
  });
});
