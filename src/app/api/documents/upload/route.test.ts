import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { document: { create: mocks.create } },
}));

// The upload directory is mocked out so the route never touches the real
// uploads tree, and the write calls stay assertable.
vi.mock("@/lib/upload-security", () => ({
  getCanonicalUploadsRoot: () => "/tmp/blackvault-test-uploads",
}));

vi.mock("fs", () => ({
  promises: { mkdir: mocks.mkdir, writeFile: mocks.writeFile },
}));

import { POST } from "./route";

// Real bytes (ASCII, so the string encodes byte-for-byte), which means
// detectFileSignature is exercised rather than mocked.
const PDF_BYTES = "%PDF-1.4\n%EOF\n";

function uploadRequest(fields: Record<string, string>, bytes = PDF_BYTES) {
  const form = new FormData();
  form.set("file", new File([bytes], "receipt.pdf"));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  return new NextRequest("http://localhost/api/documents/upload", {
    method: "POST",
    body: form,
  });
}

// This is the endpoint DocumentUploader actually posts to (its gearId branch
// is at DocumentUploader.tsx:117); POST /api/documents (JSON) has no UI caller.
describe("POST /api/documents/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: "doc-1" });
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
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
    expect(mocks.writeFile).not.toHaveBeenCalled();
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
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
