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
