import { beforeEach, describe, expect, it, vi, Mock } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  mkdir: vi.fn(),
  writeEncryptedFile: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
  getCurrentUser: vi.fn().mockResolvedValue({
    id: "user-1",
    username: "testuser",
    displayName: "Test User",
    role: "USER",
    sessionId: "session-1",
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    document: { create: mocks.create },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => await fn({ document: { create: mocks.create } }),
  },
}));

// The upload directory and the write itself are mocked out so the route
// never touches the real uploads tree, and the write calls stay assertable.
// writeEncryptedFile (not fs.writeFile) is what the route must call.
vi.mock("@/lib/files/storage", () => ({
  documentsRoot: () => "/tmp/blackvault-test-uploads/documents",
  writeEncryptedFile: mocks.writeEncryptedFile,
}));

vi.mock("fs", () => ({
  promises: { mkdir: mocks.mkdir },
}));

import { POST } from "./route";
import { HEIC_MESSAGE } from "@/lib/images/process";
import { UPLOADS_NOT_WRITABLE_MESSAGE } from "@/lib/photos/errors";

// Real bytes (ASCII, so the string encodes byte-for-byte), which means
// detectFileSignature is exercised rather than mocked.
const PDF_BYTES = "%PDF-1.4\n%EOF\n";

function uploadRequest(
  fields: Record<string, string>,
  bytes: string | Uint8Array = PDF_BYTES,
  fileName = "receipt.pdf",
) {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], fileName));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  return new NextRequest("http://localhost/api/documents/upload", {
    method: "POST",
    body: form,
  });
}

// This is the endpoint DocumentUploader actually posts to (its gearId branch
// is at DocumentUploader.tsx:117); POST /api/documents (JSON) has no UI caller.
describe("POST /api/documents/upload", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getCurrentUser } = await import("@/lib/server/auth");
    (getCurrentUser as unknown as Mock).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: "Test User",
      role: "USER",
      sessionId: "session-1",
    });
    mocks.create.mockResolvedValue({ id: "doc-1" });
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeEncryptedFile.mockResolvedValue(undefined);
  });

  it("stores gearId and includes the gear relation", async () => {
    const response = await POST(
      uploadRequest({
        name: "Knife Receipt",
        type: "RECEIPT",
        gearId: "gear-1",
      }),
    );

    expect(response.status).toBe(201);
    const { data, include } = mocks.create.mock.calls[0][0];
    expect(data.gearId).toBe("gear-1");
    expect(data.firearmId).toBeNull();
    expect(data.accessoryId).toBeNull();
    expect(data.name).toBe("Knife Receipt");
    expect(data.type).toBe("RECEIPT");
    expect(data.mimeType).toBe("application/pdf");
    expect(include.gear).toEqual({ select: { id: true, name: true } });
  });

  it("stores the ammunition, supply and kit owners", async () => {
    const response = await POST(
      uploadRequest({ name: "Lot sheet", ammoStockId: "a1", supplyId: "s1", kitId: "k1" }),
    );

    expect(response.status).toBe(201);
    const { data, include } = mocks.create.mock.calls[0][0];
    expect(data).toMatchObject({ ammoStockId: "a1", supplyId: "s1", kitId: "k1" });
    expect(include.ammoStock).toEqual({ select: { id: true, caliber: true, brand: true } });
    expect(include.supply).toEqual({ select: { id: true, name: true } });
    expect(include.kit).toEqual({ select: { id: true, name: true } });
  });

  it.each(["EACCES", "EPERM", "EROFS"])("%s from the write answers 500 with the permissions message", async (code) => {
    mocks.writeEncryptedFile.mockRejectedValue(Object.assign(new Error("secret-detail"), { code }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(uploadRequest({ name: "Receipt" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: UPLOADS_NOT_WRITABLE_MESSAGE });
  });

  it("answers a HEIC file with the HEIC message", async () => {
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);

    const response = await POST(uploadRequest({ name: "Phone" }, heic, "IMG_1.heic"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(HEIC_MESSAGE);
    expect(mocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  it("writes through writeEncryptedFile under documentsRoot(), never fs.writeFile, and fileUrl keeps its shape", async () => {
    await POST(uploadRequest({ name: "Receipt" }));

    expect(mocks.writeEncryptedFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBuffer] = mocks.writeEncryptedFile.mock.calls[0];
    expect(writtenPath.startsWith("/tmp/blackvault-test-uploads/documents/")).toBe(true);
    expect(Buffer.isBuffer(writtenBuffer)).toBe(true);

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.fileUrl).toMatch(/^\/api\/files\/documents\/[a-f0-9]+\.pdf$/);
  });

  it("stores an image document without its GPS EXIF", async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .withMetadata({ exif: { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" } } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const response = await POST(uploadRequest({ name: "Photo", type: "PHOTO" }, jpeg, "photo.jpg"));

    expect(response.status).toBe(201);
    const written = mocks.writeEncryptedFile.mock.calls[0][1] as Buffer;
    expect((await sharp(written).metadata()).exif).toBeUndefined();
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.fileSize).toBe(written.length);
    expect(data.mimeType).toBe("image/jpeg");
    expect(data.fileUrl).toMatch(/\.jpg$/);
  });

  it("rejects an undecodable image and writes nothing", async () => {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const response = await POST(uploadRequest({ name: "Broken" }, fakePng, "broken.png"));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  it("stores a PDF byte for byte", async () => {
    await POST(uploadRequest({ name: "Receipt" }));

    const written = mocks.writeEncryptedFile.mock.calls[0][1] as Buffer;
    expect(written.equals(Buffer.from(PDF_BYTES))).toBe(true);
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.fileSize).toBe(PDF_BYTES.length);
  });

  it("stores all three entity ids as null when none is sent", async () => {
    await POST(uploadRequest({ name: "Loose Receipt" }));

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.firearmId).toBeNull();
    expect(data.accessoryId).toBeNull();
    expect(data.gearId).toBeNull();
    // The route's own default when the uploader sends no type.
    expect(data.type).toBe("RECEIPT");
  });

  it("treats an empty gearId as unattached rather than an empty string", async () => {
    await POST(uploadRequest({ name: "Blank Link", gearId: "" }));

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.gearId).toBeNull();
  });

  it("requires a name and writes nothing without one", async () => {
    const response = await POST(uploadRequest({ gearId: "gear-1" }));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  it("rejects a file whose bytes are not an allowed type", async () => {
    const response = await POST(
      uploadRequest(
        { name: "Not a PDF", gearId: "gear-1" },
        "this is plain text, not a document",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  it("rate limits by user ID: two different users have separate buckets", async () => {
    const { enforceRateLimit } = await import("@/lib/rate-limit");

    // First user
    await POST(uploadRequest({ name: "Doc 1" }));
    const firstCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];
    expect(firstCall.key).toBe("upload:documents:u:user-1");

    vi.clearAllMocks();

    // Mock a different user
    const { getCurrentUser } = await import("@/lib/server/auth");
    (getCurrentUser as unknown as Mock).mockResolvedValue({
      id: "user-2",
      username: "otheruser",
      displayName: "Other User",
      role: "USER",
      sessionId: "session-2",
    });

    // Second user
    await POST(uploadRequest({ name: "Doc 2" }));
    const secondCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];
    expect(secondCall.key).toBe("upload:documents:u:user-2");

    // Keys are different — separate buckets
    expect(firstCall.key).not.toBe(secondCall.key);
  });

  it("rate limits by user ID: same user uploading twice uses the same bucket", async () => {
    const { enforceRateLimit } = await import("@/lib/rate-limit");
    const { getCurrentUser } = await import("@/lib/server/auth");

    // First upload
    await POST(uploadRequest({ name: "Doc 1" }));
    const firstCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];

    vi.clearAllMocks();

    // Restore the mock after clearing
    (getCurrentUser as unknown as Mock).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: "Test User",
      role: "USER",
      sessionId: "session-1",
    });

    // Second upload (same user)
    await POST(uploadRequest({ name: "Doc 2" }));
    const secondCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];

    // Both use the same user ID key
    expect(firstCall.key).toBe("upload:documents:u:user-1");
    expect(secondCall.key).toBe("upload:documents:u:user-1");
  });
});
