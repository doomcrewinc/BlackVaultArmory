import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
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
  it("accepts gear as an entity type", async () => {
    const response = await POST(uploadRequest("gear"));
    const json = await response.json();

    // Gear is past the entityType gate; only the file signature is rejected.
    expect(json.error).not.toContain("Invalid entityType");
    expect(json.error).toContain("Invalid file type");
  });

  it("still rejects an unknown entity type", async () => {
    const response = await POST(uploadRequest("supply"));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("Invalid entityType");
  });
});
