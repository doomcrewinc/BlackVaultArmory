import { beforeEach, describe, expect, it, vi, Mock } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";

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

const storageMocks = vi.hoisted(() => ({
  writeEncryptedFile: vi.fn(),
}));

// The uploads root and the write itself are mocked out so the route never
// touches the real uploads tree, and the write calls stay assertable.
// writeEncryptedFile (not fs.writeFile) is what the route must call.
vi.mock("@/lib/files/storage", () => ({
  uploadsRoot: () => "/tmp/blackvault-test-uploads",
  writeEncryptedFile: storageMocks.writeEncryptedFile,
}));

import { POST } from "./route";
import { HEIC_MESSAGE } from "@/lib/images/process";

// Bytes that match no known image signature, so the request is rejected on the
// file-type check — after the entityType gate. That keeps the assertion about
// which entity types are accepted and writes nothing to disk.
function uploadRequest(entityType: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "photo.png"));
  form.set("entityType", entityType);
  form.set("entityId", "gear-1");

  return new NextRequest("http://localhost/api/images/upload", {
    method: "POST",
    body: form,
  });
}

async function realPng() {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

function uploadOf(bytes: Uint8Array, name: string, entityType = "firearm", entityId = "gear-1") {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name));
  form.set("entityType", entityType);
  form.set("entityId", entityId);

  return new NextRequest("http://localhost/api/images/upload", {
    method: "POST",
    body: form,
  });
}

async function validPngUploadRequest(entityType: string, entityId: string) {
  return uploadOf(await realPng(), "photo.png", entityType, entityId);
}

describe("POST /api/images/upload", () => {
  beforeEach(async () => {
    const { getCurrentUser } = await import("@/lib/server/auth");
    vi.clearAllMocks();
    (getCurrentUser as unknown as Mock).mockResolvedValue({
      id: "user-1",
      username: "testuser",
      displayName: "Test User",
      role: "USER",
      sessionId: "session-1",
    });
    storageMocks.writeEncryptedFile.mockResolvedValue(undefined);
  });

  it("writes through writeEncryptedFile under uploadsRoot(), never fs.writeFile", async () => {
    const entityId = "cm2x9k3qw-ab_01"; // a cuid can contain - and _
    const response = await POST(await validPngUploadRequest("firearm", entityId));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(storageMocks.writeEncryptedFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBuffer] = storageMocks.writeEncryptedFile.mock.calls[0];
    expect(writtenPath).toBe(`/tmp/blackvault-test-uploads/images/firearms/${json.fileName}`);
    expect(json.fileName).toContain(entityId);
    expect(Buffer.isBuffer(writtenBuffer)).toBe(true);
  });

  it("writes a JPEG without its GPS EXIF and reports the stored size and type", async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .withMetadata({ exif: { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" } } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const response = await POST(uploadOf(jpeg, "photo.jpg"));
    const json = await response.json();

    expect(response.status).toBe(201);
    const written = storageMocks.writeEncryptedFile.mock.calls[0][1] as Buffer;
    expect((await sharp(written).metadata()).exif).toBeUndefined();
    expect(json.size).toBe(written.length);
    expect(json.mimeType).toBe("image/jpeg");
    expect(json.fileName).toMatch(/\.jpg$/);
  });

  it("rejects a HEIC file with the HEIC message and writes nothing", async () => {
    const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const response = await POST(uploadOf(heic, "photo.heic"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(HEIC_MESSAGE);
    expect(storageMocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  it("rejects a file of 25 MB plus one byte", async () => {
    const response = await POST(uploadOf(new Uint8Array(25 * 1024 * 1024 + 1), "big.jpg"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("File too large. Maximum size is 25MB.");
    expect(storageMocks.writeEncryptedFile).not.toHaveBeenCalled();
  });

  it("accepts gear as an entity type", async () => {
    const response = await POST(uploadRequest("gear"));
    const json = await response.json();

    // Gear is past the entityType gate; only the file signature is rejected.
    expect(json.error).not.toContain("Invalid entityType");
    expect(json.error).toContain("Invalid file type");
  });

  // Kit.imageUrl shipped with the model and was a dead column until phase 6
  // task 6 wired this allowlist, ImagePicker's union and the kit edit form.
  it("accepts kit as an entity type", async () => {
    const response = await POST(uploadRequest("kit"));
    const json = await response.json();

    expect(json.error).not.toContain("Invalid entityType");
    expect(json.error).toContain("Invalid file type");
  });

  it("still rejects an unknown entity type", async () => {
    const response = await POST(uploadRequest("supply"));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("Invalid entityType");
  });

  it("rate limits by user ID: two different users have separate buckets", async () => {
    const { enforceRateLimit } = await import("@/lib/rate-limit");

    // First user
    await POST(uploadRequest("gear"));
    const firstCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];
    expect(firstCall.key).toBe("upload:images:u:user-1");

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
    await POST(uploadRequest("gear"));
    const secondCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];
    expect(secondCall.key).toBe("upload:images:u:user-2");

    // Keys are different — separate buckets
    expect(firstCall.key).not.toBe(secondCall.key);
  });

  it("rate limits by user ID: same user uploading twice uses the same bucket", async () => {
    const { enforceRateLimit } = await import("@/lib/rate-limit");
    const { getCurrentUser } = await import("@/lib/server/auth");

    // First upload
    await POST(uploadRequest("gear"));
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
    await POST(uploadRequest("gear"));
    const secondCall = (enforceRateLimit as unknown as Mock).mock.calls[0][0];

    // Both use the same user ID key
    expect(firstCall.key).toBe("upload:images:u:user-1");
    expect(secondCall.key).toBe("upload:images:u:user-1");
  });
});
