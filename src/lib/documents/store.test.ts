import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  unlink: vi.fn(),
  writeEncryptedFile: vi.fn(),
  create: vi.fn(),
}));

vi.mock("node:fs", () => ({ promises: { mkdir: mocks.mkdir, unlink: mocks.unlink } }));
vi.mock("@/lib/files/storage", () => ({
  documentsRoot: () => "/tmp/bv-docs-test",
  writeEncryptedFile: mocks.writeEncryptedFile,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => await fn({ document: { create: mocks.create } }),
  },
}));

import { storeDocument } from "./store";

const input = {
  bytes: Buffer.from("x"),
  extension: "jpg",
  mimeType: "image/jpeg",
  name: "Receipt",
  type: "RECEIPT",
  notes: null,
  owners: { gearId: "g1" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.writeEncryptedFile.mockResolvedValue(undefined);
});

describe("storeDocument", () => {
  it("writes the file, then creates the row for exactly the given owner", async () => {
    mocks.create.mockResolvedValue({ id: "d1" });
    expect(await storeDocument(input)).toEqual({ id: "d1" });
    const { data } = mocks.create.mock.calls[0][0];
    expect(data).toMatchObject({ gearId: "g1", firearmId: null, kitId: null, fileSize: 1 });
    expect(data.fileUrl).toMatch(/^\/api\/files\/documents\/[0-9a-f]{32}\.jpg$/);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("removes the written file and rethrows when the row cannot be created", async () => {
    const boom = new Error("insert failed");
    mocks.create.mockRejectedValue(boom);
    await expect(storeDocument(input)).rejects.toBe(boom);
    const written = mocks.writeEncryptedFile.mock.calls[0][0];
    expect(mocks.unlink).toHaveBeenCalledWith(written);
  });

  it("still rethrows the insert error when the cleanup itself fails", async () => {
    const boom = new Error("insert failed");
    mocks.create.mockRejectedValue(boom);
    mocks.unlink.mockRejectedValue(new Error("gone"));
    await expect(storeDocument(input)).rejects.toBe(boom);
  });

  it.each(["exe", "../x", "jpg/../../x", ""])("refuses the extension %j and writes nothing", async (extension) => {
    await expect(storeDocument({ ...input, extension })).rejects.toThrow("Unsupported document extension");
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeEncryptedFile).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["jpg", "png", "webp", "pdf"])("accepts the extension %s", async (extension) => {
    mocks.create.mockResolvedValue({ id: "d1" });
    await storeDocument({ ...input, extension });
    expect(mocks.writeEncryptedFile.mock.calls[0][0]).toMatch(new RegExp(`/tmp/bv-docs-test/[0-9a-f]{32}\\.${extension}$`));
  });

  it("creates no row when the write fails", async () => {
    const boom = new Error("disk full");
    mocks.writeEncryptedFile.mockRejectedValue(boom);
    await expect(storeDocument(input)).rejects.toBe(boom);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
