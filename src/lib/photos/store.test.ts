import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Photo } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  photoCreate: vi.fn(),
  photoFindMany: vi.fn(),
  itemFindUnique: vi.fn(),
  itemUpdate: vi.fn(),
  writeEncryptedFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    photo: { create: mocks.photoCreate },
    gear: { findUnique: mocks.itemFindUnique, update: mocks.itemUpdate },
  };
  return {
    prisma: {
      photo: { findMany: mocks.photoFindMany },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock("@/lib/files/storage", () => ({
  uploadsRoot: () => "/root",
  writeEncryptedFile: mocks.writeEncryptedFile,
}));

vi.mock("node:fs/promises", () => ({
  default: { mkdir: mocks.mkdir, unlink: mocks.unlink },
  mkdir: mocks.mkdir,
  unlink: mocks.unlink,
}));

vi.mock("@/lib/images/process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/images/process")>();
  return {
    ...actual,
    processPicture: vi.fn().mockResolvedValue({
      bytes: Buffer.from("orig"),
      preview: Buffer.from("thumb"),
      extension: "jpg",
      mimeType: "image/jpeg",
      width: 40,
      height: 30,
    }),
  };
});

import { addPhoto, normaliseLabel, photoFilesFor, removePhotoFiles, toPhotoDto } from "./store";

const input = {
  bytes: Buffer.from("x"),
  type: "gear" as const,
  entityId: "g1",
  label: "left side",
  createdById: "u1",
  viaPass: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.photoCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    createdAt: new Date("2026-10-04T00:00:00Z"),
  }));
  mocks.itemFindUnique.mockResolvedValue({ imageUrl: null });
});

describe("addPhoto", () => {
  it("writes both files under the generated id, then creates the row with that id", async () => {
    const photo = await addPhoto(input);

    expect(photo.id).toMatch(/^[0-9a-f]{32}$/);
    const paths = mocks.writeEncryptedFile.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      `/root/images/photos/${photo.id}.jpg`,
      `/root/images/photos/thumbs/${photo.id}.webp`,
    ]);
    expect(mocks.photoCreate.mock.calls[0][0].data).toMatchObject({
      id: photo.id,
      fileName: `${photo.id}.jpg`,
      gearId: "g1",
      label: "left side",
      createdById: "u1",
      viaPass: false,
      width: 40,
      height: 30,
      fileSize: 4,
    });
  });

  it("removes both files and rethrows when the row cannot be created", async () => {
    const boom = new Error("db down");
    mocks.photoCreate.mockRejectedValue(boom);

    await expect(addPhoto(input)).rejects.toBe(boom);

    const [orig, thumb] = mocks.writeEncryptedFile.mock.calls.map((c) => c[0]);
    expect(mocks.unlink.mock.calls.map((c) => c[0]).sort()).toEqual([orig, thumb].sort());
  });

  it("removes the first file when the second write fails", async () => {
    mocks.writeEncryptedFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));

    await expect(addPhoto(input)).rejects.toThrow("disk full");

    expect(mocks.photoCreate).not.toHaveBeenCalled();
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it("makes the photo the main picture when the item has none", async () => {
    const photo = await addPhoto(input);

    expect(mocks.itemUpdate).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { imageUrl: `/uploads/images/photos/${photo.id}.jpg` },
    });
  });

  it("leaves an existing main picture alone", async () => {
    mocks.itemFindUnique.mockResolvedValue({ imageUrl: "/uploads/images/gears/old.jpg" });

    await addPhoto(input);

    expect(mocks.itemUpdate).not.toHaveBeenCalled();
  });
});

describe("normaliseLabel", () => {
  it.each([
    ["  left side ", "left side"],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ])("%j gives %j", (raw, expected) => {
    expect(normaliseLabel(raw)).toBe(expected);
  });

  it("accepts 80 characters and rejects 81", () => {
    expect(normaliseLabel("a".repeat(80))).toBe("a".repeat(80));
    expect(() => normaliseLabel("a".repeat(81))).toThrow(RangeError);
  });
});

describe("removePhotoFiles", () => {
  const photos = [{ id: "p1", fileName: "p1.png" }];

  it("removes the original and the preview", async () => {
    await removePhotoFiles(photos);
    expect(mocks.unlink.mock.calls.map((c) => c[0]).sort()).toEqual([
      "/root/images/photos/p1.png",
      "/root/images/photos/thumbs/p1.webp",
    ]);
  });

  it("ignores ENOENT quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.unlink.mockRejectedValue(Object.assign(new Error("gone"), { code: "ENOENT" }));
    await expect(removePhotoFiles(photos)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs and does not throw on any other error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.unlink.mockRejectedValue(Object.assign(new Error("MARKER-secret"), { code: "EACCES" }));
    await expect(removePhotoFiles(photos)).resolves.toBeUndefined();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("p1");
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain("MARKER-secret");
  });
});

describe("photoFilesFor", () => {
  it("returns id and file name of the matching photos", async () => {
    mocks.photoFindMany.mockResolvedValue([{ id: "p1", fileName: "p1.jpg" }]);
    await expect(photoFilesFor({ gearId: "g1" })).resolves.toEqual([{ id: "p1", fileName: "p1.jpg" }]);
    expect(mocks.photoFindMany).toHaveBeenCalledWith({
      where: { gearId: "g1" },
      select: { id: true, fileName: true },
    });
  });
});

describe("toPhotoDto", () => {
  const photo = {
    id: "p1",
    fileName: "p1.jpg",
    fileSize: 10,
    width: 4,
    height: 3,
    label: null,
    viaPass: true,
    createdAt: new Date("2026-10-04T00:00:00Z"),
  } as Photo;

  it.each([
    ["/uploads/images/photos/p1.jpg", true],
    ["/other.jpg", false],
    [null, false],
  ])("main picture %j gives isMain %s", (main, isMain) => {
    expect(toPhotoDto(photo, main)).toEqual({
      id: "p1",
      url: "/uploads/images/photos/p1.jpg",
      previewUrl: "/uploads/images/photos/thumbs/p1.webp",
      label: null,
      width: 4,
      height: 3,
      fileSize: 10,
      viaPass: true,
      createdAt: "2026-10-04T00:00:00.000Z",
      isMain,
    });
  });
});
