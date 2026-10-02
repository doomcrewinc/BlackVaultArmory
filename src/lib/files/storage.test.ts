import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { resetFieldKeysForTests } from "@/lib/encryption/keys";
import {
  FileAtRestError,
  documentsRoot,
  fileResponseHeaders,
  legacyDocumentsRoot,
  readDecryptedFile,
  uploadsRoot,
  writeAtomic,
  writeEncryptedFile,
} from "./storage";

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
    document: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "doc-1",
        ...data,
      })),
    },
  },
}));

// Imported statically: both routes resolve the uploads root at call time
// (via uploadsRoot()/documentsRoot(), which read IMAGE_UPLOAD_DIR from
// process.env on every call), so import order relative to beforeEach's
// process.env write below does not matter.
import { POST as uploadDocument } from "@/app/api/documents/upload/route";
import { GET as serveDocument } from "@/app/api/files/documents/[fileName]/route";
import { POST as uploadImage } from "@/app/api/images/upload/route";
import { GET as serveUpload } from "@/app/uploads/[...path]/route";
import { GET as libraryImages } from "@/app/api/images/library/route";

// Real PNG magic (first 8 bytes) padded to the 12 bytes detectFileSignature
// requires. Not a valid full PNG, but enough to pass signature detection.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF_TEXT = "%PDF-1.4\nreceipt body\n%%EOF\n";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bv-files-test-"));
  process.env.IMAGE_UPLOAD_DIR = tmpRoot;
  resetFieldKeysForTests();
});

afterEach(async () => {
  delete process.env.IMAGE_UPLOAD_DIR;
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  resetFieldKeysForTests();
  // clearAllMocks only resets calls/results, not implementations: the
  // vi.mock() factories above set each mock's resolved value exactly once,
  // at module-mock time, and vi.restoreAllMocks() would wipe that back to
  // "no implementation" (undefined) for a plain vi.fn() with nothing to
  // restore to, breaking every route call after the first test.
  vi.clearAllMocks();
});

describe("uploadsRoot / documentsRoot / legacyDocumentsRoot", () => {
  it("uploadsRoot honours IMAGE_UPLOAD_DIR", () => {
    expect(uploadsRoot()).toBe(path.resolve(tmpRoot));
  });

  it("uploadsRoot falls back to <cwd>/uploads when IMAGE_UPLOAD_DIR is unset", () => {
    expect(uploadsRoot({} as unknown as NodeJS.ProcessEnv)).toBe(path.join(process.cwd(), "uploads"));
  });

  it("documentsRoot is <uploadsRoot>/documents", () => {
    expect(documentsRoot()).toBe(path.join(uploadsRoot(), "documents"));
  });

  it("legacyDocumentsRoot is <cwd>/storage/uploads/documents", () => {
    expect(legacyDocumentsRoot("/app")).toBe(path.join("/app", "storage", "uploads", "documents"));
  });
});

describe("writeAtomic / writeEncryptedFile", () => {
  it("writeEncryptedFile writes a BVF1 file with mode 600 and leaves no .tmp file", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "abc123.pdf");

    await writeEncryptedFile(target, Buffer.from(PDF_TEXT));

    const stored = await fsp.readFile(target);
    expect(stored.subarray(0, 4).toString("ascii")).toBe("BVF1");

    const stat = await fsp.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);

    const entries = await fsp.readdir(dir);
    expect(entries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("an injected write failure keeps the original intact and leaves no .tmp file", async () => {
    const dir = path.join(tmpRoot, "injected");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "existing.pdf");
    const original = Buffer.from("%PDF-1.4\noriginal bytes\n");
    await fsp.writeFile(target, original);

    const realOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === `${target}.tmp`) {
        vi.spyOn(handle, "write").mockRejectedValue(new Error("simulated disk full"));
      }
      return handle;
    }) as unknown as typeof fsp.open);

    try {
      await expect(writeAtomic(target, Buffer.from("new bytes"))).rejects.toThrow("simulated disk full");
    } finally {
      openSpy.mockRestore();
    }

    const afterBytes = await fsp.readFile(target);
    expect(afterBytes.equals(original)).toBe(true);

    const entries = await fsp.readdir(dir);
    expect(entries).toEqual(["existing.pdf"]);
  });
});

describe("readDecryptedFile", () => {
  it("returns the original bytes", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "roundtrip.pdf");
    const plaintext = Buffer.from("roundtrip bytes, exactly these");
    await writeEncryptedFile(target, plaintext);

    const decrypted = await readDecryptedFile(target);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("plaintext on disk gives PLAINTEXT_AT_REST", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "plain.pdf");
    await fsp.writeFile(target, "%PDF-1.4\nplaintext on disk\n");

    await expect(readDecryptedFile(target)).rejects.toBeInstanceOf(FileAtRestError);
    await expect(readDecryptedFile(target)).rejects.toMatchObject({ code: "PLAINTEXT_AT_REST", path: target });
  });

  it("a corrupted byte gives DECRYPT_FAILED", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "corrupt.pdf");
    await writeEncryptedFile(target, Buffer.from("hello world"));

    const bytes = await fsp.readFile(target);
    bytes[bytes.length - 1] ^= 1; // flip a tag byte
    await fsp.writeFile(target, bytes);

    await expect(readDecryptedFile(target)).rejects.toBeInstanceOf(FileAtRestError);
    await expect(readDecryptedFile(target)).rejects.toMatchObject({ code: "DECRYPT_FAILED", path: target });
  });
});

describe("fileResponseHeaders", () => {
  it("sends Cache-Control: private, no-store plus the existing security headers", () => {
    const headers = fileResponseHeaders("application/pdf");
    expect(headers.get("Content-Type")).toBe("application/pdf");
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("Content-Disposition")).toBe("inline");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });
});

function documentUploadRequest(fields: Record<string, string>, bytes: string) {
  const form = new FormData();
  form.set("file", new File([bytes], "receipt.pdf"));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new NextRequest("http://localhost/api/documents/upload", { method: "POST", body: form });
}

function imageUploadRequest(entityType: string, entityId: string, bytes: Buffer, filename = "photo.png") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename));
  form.set("entityType", entityType);
  form.set("entityId", entityId);
  return new NextRequest("http://localhost/api/images/upload", { method: "POST", body: form });
}

describe("end-to-end: upload then serve, real filesystem", () => {
  it("document upload writes BVF1 under documentsRoot(), and the serving route decrypts it with no-store", async () => {
    const res = await uploadDocument(documentUploadRequest({ name: "Receipt" }, PDF_TEXT));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fileUrl).toMatch(/^\/api\/files\/documents\/[A-Za-z0-9]+\.pdf$/);

    const fileName = body.fileUrl.split("/").pop() as string;
    const onDisk = await fsp.readFile(path.join(documentsRoot(), fileName));
    expect(onDisk.subarray(0, 4).toString("ascii")).toBe("BVF1");

    const serveRes = await serveDocument(new NextRequest(`http://localhost${body.fileUrl}`), {
      params: Promise.resolve({ fileName }),
    });
    expect(serveRes.status).toBe(200);
    expect(serveRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(serveRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(serveRes.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    const served = Buffer.from(await serveRes.arrayBuffer());
    expect(served.toString()).toBe(PDF_TEXT);
  });

  // Review Focus 4: the image route's filename is `${entityId}_${Date.now()}.${ext}`,
  // and a real cuid can contain both `-` and `_`. The AAD basename must match
  // exactly between write and read, so this drives the REAL upload route then
  // the REAL serving route, not a mocked basename.
  it("image upload writes BVF1 for a cuid entity id containing - and _, and the serving route decrypts it", async () => {
    const entityId = "cm2x9k3qw-ab_01";
    const res = await uploadImage(imageUploadRequest("firearm", entityId, PNG_BYTES));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fileName).toContain(entityId);

    const onDiskPath = path.join(uploadsRoot(), "images", "firearms", body.fileName);
    const onDisk = await fsp.readFile(onDiskPath);
    expect(onDisk.subarray(0, 4).toString("ascii")).toBe("BVF1");

    const serveRes = await serveUpload(new NextRequest(`http://localhost${body.url}`), {
      params: Promise.resolve({ path: ["images", "firearms", body.fileName] }),
    });
    expect(serveRes.status).toBe(200);
    expect(serveRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(serveRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const served = Buffer.from(await serveRes.arrayBuffer());
    expect(served.equals(PNG_BYTES)).toBe(true);
  });

  it("a plaintext document at rest gives 500 with a generic body", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });
    const fileName = "legacy-plaintext.pdf";
    await fsp.writeFile(path.join(dir, fileName), "%PDF-1.4\nnever encrypted\n");

    const serveRes = await serveDocument(new NextRequest(`http://localhost/api/files/documents/${fileName}`), {
      params: Promise.resolve({ fileName }),
    });
    expect(serveRes.status).toBe(500);
    const json = await serveRes.json();
    expect(json.error).toBeTruthy();
  });

  it("a plaintext image at rest gives 500 with a generic body", async () => {
    const dir = path.join(uploadsRoot(), "images", "firearms");
    await fsp.mkdir(dir, { recursive: true });
    const fileName = "legacy-plaintext.png";
    await fsp.writeFile(path.join(dir, fileName), PNG_BYTES);

    const serveRes = await serveUpload(new NextRequest(`http://localhost/uploads/images/firearms/${fileName}`), {
      params: Promise.resolve({ path: ["images", "firearms", fileName] }),
    });
    expect(serveRes.status).toBe(500);
    const json = await serveRes.json();
    expect(json.error).toBeTruthy();
  });

  it("the image library listing skips .tmp, .rot and .pre-encryption-* entries", async () => {
    const res = await uploadImage(imageUploadRequest("firearm", "lib-test-1", PNG_BYTES));
    const { fileName } = await res.json();
    const dir = path.join(uploadsRoot(), "images", "firearms");
    await fsp.writeFile(path.join(dir, "stray.tmp"), "junk");
    await fsp.writeFile(path.join(dir, "stray.rot"), "junk");
    await fsp.mkdir(path.join(dir, ".pre-encryption-20261001-000000"), { recursive: true });

    const libRes = await libraryImages();
    const { images } = await libRes.json();
    const names = (images as Array<{ url: string }>).map((img) => img.url.split("/").pop());

    expect(names).toContain(fileName);
    expect(names).not.toContain("stray.tmp");
    expect(names).not.toContain("stray.rot");
    expect(names.some((n) => n?.startsWith(".pre-encryption-"))).toBe(false);
  });

  it("image delete uses the shared uploads root", async () => {
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        document: { create: vi.fn().mockResolvedValue({ id: "doc-1" }) },
        firearm: {
          findUnique: vi.fn().mockResolvedValue({ id: "firearm-1", imageUrl: "/uploads/images/firearms/x.png" }),
          update: vi.fn().mockResolvedValue({ id: "firearm-1" }),
        },
      },
    }));
    vi.resetModules();
    const { DELETE: deleteImageFresh } = await import("@/app/api/images/delete/route");
    const { POST: uploadImageFresh } = await import("@/app/api/images/upload/route");

    const res = await uploadImageFresh(imageUploadRequest("firearm", "del-test-1", PNG_BYTES));
    const { fileName } = await res.json();
    const onDiskPath = path.join(uploadsRoot(), "images", "firearms", fileName);
    await expect(fsp.access(onDiskPath)).resolves.toBeUndefined();

    const delReq = new NextRequest(
      `http://localhost/api/images/delete?filename=${fileName}&entityType=firearm&entityId=firearm-1`,
      { method: "DELETE" },
    );
    const delRes = await deleteImageFresh(delReq);
    expect(delRes.status).toBe(200);
    await expect(fsp.access(onDiskPath)).rejects.toThrow();
  });
});
