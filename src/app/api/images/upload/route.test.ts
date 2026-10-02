import { beforeEach, describe, expect, it, vi, Mock } from "vitest";
import { NextRequest } from "next/server";

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

// A real (if minimal) PNG signature so detectFileSignature accepts it, to
// exercise the actual write path.
function validPngUploadRequest(entityType: string, entityId: string) {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const form = new FormData();
  form.set("file", new File([bytes], "photo.png"));
  form.set("entityType", entityType);
  form.set("entityId", entityId);

  return new NextRequest("http://localhost/api/images/upload", {
    method: "POST",
    body: form,
  });
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
    const response = await POST(validPngUploadRequest("firearm", entityId));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(storageMocks.writeEncryptedFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBuffer] = storageMocks.writeEncryptedFile.mock.calls[0];
    expect(writtenPath).toBe(`/tmp/blackvault-test-uploads/images/firearms/${json.fileName}`);
    expect(json.fileName).toContain(entityId);
    expect(Buffer.isBuffer(writtenBuffer)).toBe(true);
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
