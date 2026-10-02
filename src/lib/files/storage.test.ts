import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { resetFieldKeysForTests } from "@/lib/encryption/keys";
import * as keysModule from "@/lib/encryption/keys";
import * as core from "@/lib/encryption/core.mjs";
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

// A tmp file for `target` now has the shape `<target>.<8 hex>.tmp` (fix
// round 1, I2). This matches it without assuming any particular hex suffix.
function isTmpFor(candidate: string, target: string): boolean {
  return candidate.startsWith(`${target}.`) && candidate.endsWith(".tmp");
}

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
      if (isTmpFor(String(args[0]), target)) {
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

  // Fix round 1, I1: a single handle.write() issues one write(2), which can
  // return fewer bytes than asked without throwing — the old code treated
  // that as success and renamed a truncated file over the original. Two
  // regression tests: a short write that never errors must still land
  // every byte (no silent truncation), and a short write immediately
  // followed by a hard error (the realistic ENOSPC shape) must still throw,
  // keep the original, and leave no temp file — mirroring the reviewer's
  // own "real partial write then failure" experiment, which already passed,
  // to pin it permanently.
  it("a short write that never errors is retried until every byte lands, not silently truncated (I1)", async () => {
    const dir = path.join(tmpRoot, "short-write-retry");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "existing.bin");
    const original = Buffer.from("ORIGINAL-CONTENT");
    await fsp.writeFile(target, original);

    const realOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (isTmpFor(String(args[0]), target)) {
        const realWrite = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation((async (buf: Buffer) => realWrite(buf.subarray(0, 10))) as never);
      }
      return handle;
    }) as unknown as typeof fsp.open);

    try {
      await writeAtomic(target, Buffer.alloc(1000, 7));
    } finally {
      openSpy.mockRestore();
    }

    const after = await fsp.readFile(target);
    expect(after.length).toBe(1000);
    expect(after.every((b) => b === 7)).toBe(true);

    const entries = await fsp.readdir(dir);
    expect(entries).toEqual(["existing.bin"]);
  });

  it("a short write immediately followed by ENOSPC throws, keeps the original, and leaves no temp file (I1)", async () => {
    const dir = path.join(tmpRoot, "short-write-enospc");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "existing.bin");
    const original = Buffer.from("ORIGINAL-CONTENT");
    await fsp.writeFile(target, original);

    const realOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (isTmpFor(String(args[0]), target)) {
        const realWrite = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation((async (buf: Buffer) => {
          await realWrite(buf.subarray(0, 5)); // genuinely put 5 bytes on disk
          const e = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
          e.code = "ENOSPC";
          throw e;
        }) as never);
      }
      return handle;
    }) as unknown as typeof fsp.open);

    try {
      await expect(writeAtomic(target, Buffer.alloc(1000, 7))).rejects.toThrow(/ENOSPC/);
    } finally {
      openSpy.mockRestore();
    }

    const after = await fsp.readFile(target);
    expect(after.equals(original)).toBe(true);

    const entries = await fsp.readdir(dir);
    expect(entries).toEqual(["existing.bin"]);
  });

  // Fix round 1, I2: a fixed `<name>.tmp` opened with "w" let two concurrent
  // writers to the same target corrupt each other, and let a pre-planted
  // `.tmp` symlink be followed.
  it("20 rounds of concurrent writes to the same target: no corruption, no orphan temp files (I2)", async () => {
    const dir = path.join(tmpRoot, "concurrent");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "c.bin");

    for (let i = 0; i < 20; i++) {
      const a = Buffer.alloc(4 * 1024 * 1024 + (i % 3), 0x61);
      const b = Buffer.alloc(2 * 1024 * 1024, 0x62);
      const settled = await Promise.allSettled([writeAtomic(target, a), writeAtomic(target, b)]);
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);

      const after = await fsp.readFile(target);
      // One writer's rename lands last; the file is always wholly one or
      // the other, never a mix of both.
      expect(after.equals(a) || after.equals(b)).toBe(true);

      const entries = await fsp.readdir(dir);
      expect(entries).toEqual(["c.bin"]);
    }
  });

  it("20 rounds of concurrent encrypted writes to the same target: always decryptable, no orphan temp files (I2)", async () => {
    const dir = path.join(tmpRoot, "concurrent-enc");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "e.bin");

    for (let i = 0; i < 20; i++) {
      const a = Buffer.alloc(3 * 1024 * 1024, 1);
      const b = Buffer.alloc(1 * 1024 * 1024, 2);
      const settled = await Promise.allSettled([writeEncryptedFile(target, a), writeEncryptedFile(target, b)]);
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);

      const decrypted = await readDecryptedFile(target);
      expect(decrypted.equals(a) || decrypted.equals(b)).toBe(true);

      const entries = await fsp.readdir(dir);
      expect(entries).toEqual(["e.bin"]);
    }
  });

  it("a pre-existing symlink at the generated temp path is refused, not followed (I2)", async () => {
    const dir = path.join(tmpRoot, "symlink-tmp");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "s.bin");
    const victim = path.join(dir, "victim.txt");
    await fsp.writeFile(victim, "VICTIM");

    // Simulate an attacker who — despite the random suffix — managed to
    // pre-create a symlink at the exact path writeAtomic is about to open.
    // "wx" must refuse it (EEXIST: the path already exists) rather than
    // open and write through the symlink.
    const realOpen = fsp.open.bind(fsp);
    let planted = false;
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const p = String(args[0]);
      if (!planted && p.endsWith(".tmp") && p !== target) {
        planted = true;
        await fsp.symlink(victim, p);
      }
      return realOpen(...args);
    }) as unknown as typeof fsp.open);

    try {
      await expect(writeAtomic(target, Buffer.from("ATTACK"))).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      openSpy.mockRestore();
    }

    expect(await fsp.readFile(victim, "utf8")).toBe("VICTIM");
    await expect(fsp.access(target)).rejects.toThrow();
  });

  it("the unique temp file name still ends in .tmp (matches Task 3's startup *.tmp sweep) (I2)", async () => {
    const dir = path.join(tmpRoot, "glob-match");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "g.bin");

    const realOpen = fsp.open.bind(fsp);
    let capturedTmpPath = "";
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const p = String(args[0]);
      if (isTmpFor(p, target)) capturedTmpPath = p;
      return realOpen(...args);
    }) as unknown as typeof fsp.open);

    try {
      await writeAtomic(target, Buffer.from("hello"));
    } finally {
      openSpy.mockRestore();
    }

    expect(capturedTmpPath).not.toBe("");
    expect(capturedTmpPath.endsWith(".tmp")).toBe(true);
    expect(path.basename(capturedTmpPath)).toMatch(/^g\.bin\.[0-9a-f]{8}\.tmp$/);
  });

  // Fix round 1, m1: nothing pinned the fsync order, so a mutant dropping
  // either fsync survived the suite. Spy on every fs call writeAtomic makes
  // and assert the exact order.
  it("writes in order: chmod, write, file-fsync, close, rename, dir-open, dir-fsync, dir-close (m1)", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "order.pdf");
    const order: string[] = [];

    const realOpen = fsp.open.bind(fsp);
    const realRename = fsp.rename.bind(fsp);
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (isTmpFor(String(args[0]), target)) {
        const realChmod = handle.chmod.bind(handle);
        const realWrite = handle.write.bind(handle);
        const realSync = handle.sync.bind(handle);
        const realClose = handle.close.bind(handle);
        vi.spyOn(handle, "chmod").mockImplementation((async (...a: Parameters<typeof realChmod>) => {
          order.push("chmod");
          return realChmod(...a);
        }) as never);
        vi.spyOn(handle, "write").mockImplementation((async (...a: Parameters<typeof realWrite>) => {
          order.push("write");
          return realWrite(...a);
        }) as never);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          order.push("file-sync");
          return realSync();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          order.push("close");
          return realClose();
        });
      } else {
        order.push("dir-open");
        const realSync = handle.sync.bind(handle);
        const realClose = handle.close.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          order.push("dir-sync");
          return realSync();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          order.push("dir-close");
          return realClose();
        });
      }
      return handle;
    }) as unknown as typeof fsp.open);
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation((async (...a: Parameters<typeof realRename>) => {
      order.push("rename");
      return realRename(...a);
    }) as never);

    try {
      await writeAtomic(target, Buffer.from("hello order"));
    } finally {
      openSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(order).toEqual(["chmod", "write", "file-sync", "close", "rename", "dir-open", "dir-sync", "dir-close"]);
  });

  // Fix round 1, m2: a failed rename used to leave the .tmp file behind.
  it("a rename failure removes the temp file and leaves the original intact (m2)", async () => {
    const dir = path.join(tmpRoot, "rename-fail");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "z.bin");
    const original = Buffer.from("ORIG");
    await fsp.writeFile(target, original);

    const renameSpy = vi
      .spyOn(fsp, "rename")
      .mockRejectedValue(Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }));

    try {
      await expect(writeAtomic(target, Buffer.from("new"))).rejects.toMatchObject({ code: "EXDEV" });
    } finally {
      renameSpy.mockRestore();
    }

    const entries = await fsp.readdir(dir);
    expect(entries).toEqual(["z.bin"]);
    expect((await fsp.readFile(target)).equals(original)).toBe(true);
  });

  // Fix round 1, m8: Windows can raise these from fsyncing a directory
  // handle; the write itself already landed (the rename succeeded), so
  // writeAtomic must not fail the whole operation over it.
  it.each(["EPERM", "EISDIR", "EINVAL"])(
    "tolerates a directory-fsync failure coded %s (m8)",
    async (code) => {
      const dir = path.join(tmpRoot, `dirfsync-${code}`);
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, "d.bin");

      const realOpen = fsp.open.bind(fsp);
      const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        if (!isTmpFor(String(args[0]), target) && String(args[0]) === dir) {
          const e = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
          e.code = code;
          throw e;
        }
        return realOpen(...args);
      }) as unknown as typeof fsp.open);

      try {
        await expect(writeAtomic(target, Buffer.from("payload"))).resolves.toBeUndefined();
      } finally {
        openSpy.mockRestore();
      }

      expect((await fsp.readFile(target)).toString()).toBe("payload");
    },
  );

  it("does not tolerate an unrelated directory-fsync failure code (m8)", async () => {
    const dir = path.join(tmpRoot, "dirfsync-other");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, "d.bin");

    const realOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      if (!isTmpFor(String(args[0]), target) && String(args[0]) === dir) {
        const e = new Error("simulated EACCES") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      return realOpen(...args);
    }) as unknown as typeof fsp.open);

    try {
      await expect(writeAtomic(target, Buffer.from("payload"))).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      openSpy.mockRestore();
    }
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

describe("FileAtRestError.causeCode (m3)", () => {
  it("is undefined for PLAINTEXT_AT_REST — there is no decrypt failure to name", () => {
    const err = new FileAtRestError("PLAINTEXT_AT_REST", "/x");
    expect(err.causeCode).toBeUndefined();
  });

  it("carries the underlying EncryptionKeyError code for DECRYPT_FAILED", () => {
    const cause = Object.assign(new Error("bad"), { code: "KEY_MISMATCH" });
    const err = new FileAtRestError("DECRYPT_FAILED", "/x", cause);
    expect(err.causeCode).toBe("KEY_MISMATCH");
  });

  it("falls back to AUTH_FAILED for a plain, code-less GCM auth failure (M6)", () => {
    const err = new FileAtRestError("DECRYPT_FAILED", "/x", new Error("Unsupported state or unable to authenticate data"));
    expect(err.causeCode).toBe("AUTH_FAILED");
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

describe("serving routes: logged code and error mapping (fix round 1, m3/m4)", () => {
  it("documents: logs the underlying code for KEY_MISMATCH and a GCM auth failure (m3)", async () => {
    const dir = documentsRoot();
    await fsp.mkdir(dir, { recursive: true });

    const other = core.deriveKeys(core.parseKeyHex("b".repeat(64)));
    const mismatchName = "mismatch.pdf";
    await fsp.writeFile(
      path.join(dir, mismatchName),
      core.encryptFile(other, mismatchName, Buffer.from(PDF_TEXT)),
    );

    const tamperedName = "tampered.pdf";
    await writeEncryptedFile(path.join(dir, tamperedName), Buffer.from(PDF_TEXT));
    const tampered = Buffer.from(await fsp.readFile(path.join(dir, tamperedName)));
    tampered[tampered.length - 1] ^= 1; // flip a tag byte -> GCM auth failure, no .code
    await fsp.writeFile(path.join(dir, tamperedName), tampered);

    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });

    try {
      const r1 = await serveDocument(new NextRequest(`http://localhost/api/files/documents/${mismatchName}`), {
        params: Promise.resolve({ fileName: mismatchName }),
      });
      expect(r1.status).toBe(500);

      const r2 = await serveDocument(new NextRequest(`http://localhost/api/files/documents/${tamperedName}`), {
        params: Promise.resolve({ fileName: tamperedName }),
      });
      expect(r2.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }

    expect(errs.some((l) => l.includes("DECRYPT_FAILED") && l.includes("KEY_MISMATCH"))).toBe(true);
    expect(errs.some((l) => l.includes("DECRYPT_FAILED") && l.includes("AUTH_FAILED"))).toBe(true);
  });

  it("uploads: logs the underlying code for KEY_MISMATCH and a GCM auth failure (m3)", async () => {
    const dir = path.join(uploadsRoot(), "images", "firearms");
    await fsp.mkdir(dir, { recursive: true });

    const other = core.deriveKeys(core.parseKeyHex("b".repeat(64)));
    const mismatchName = "mismatch.png";
    await fsp.writeFile(path.join(dir, mismatchName), core.encryptFile(other, mismatchName, PNG_BYTES));

    const tamperedName = "tampered.png";
    await writeEncryptedFile(path.join(dir, tamperedName), PNG_BYTES);
    const tampered = Buffer.from(await fsp.readFile(path.join(dir, tamperedName)));
    tampered[tampered.length - 1] ^= 1;
    await fsp.writeFile(path.join(dir, tamperedName), tampered);

    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });

    try {
      const r1 = await serveUpload(new NextRequest("http://localhost/x"), {
        params: Promise.resolve({ path: ["images", "firearms", mismatchName] }),
      });
      expect(r1.status).toBe(500);

      const r2 = await serveUpload(new NextRequest("http://localhost/x"), {
        params: Promise.resolve({ path: ["images", "firearms", tamperedName] }),
      });
      expect(r2.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }

    expect(errs.some((l) => l.includes("DECRYPT_FAILED") && l.includes("KEY_MISMATCH"))).toBe(true);
    expect(errs.some((l) => l.includes("DECRYPT_FAILED") && l.includes("AUTH_FAILED"))).toBe(true);
  });

  it("uploads: a non-FileAtRestError (getFieldKeys throwing) is logged and returns 500, not a silent 404 (m4)", async () => {
    const dir = path.join(uploadsRoot(), "images", "firearms");
    await fsp.mkdir(dir, { recursive: true });
    const fileName = "g.png";
    await writeEncryptedFile(path.join(dir, fileName), PNG_BYTES);

    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
    const keysSpy = vi.spyOn(keysModule, "getFieldKeys").mockImplementation(() => {
      throw new Error("no key loaded");
    });

    let res: Response;
    try {
      res = await serveUpload(new NextRequest("http://localhost/x"), {
        params: Promise.resolve({ path: ["images", "firearms", fileName] }),
      });
    } finally {
      keysSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(errs.length).toBeGreaterThan(0);
  });

  it("uploads: a genuinely missing file still returns 404 (m4)", async () => {
    const dir = path.join(uploadsRoot(), "images", "firearms");
    await fsp.mkdir(dir, { recursive: true });

    const res = await serveUpload(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ path: ["images", "firearms", "does-not-exist.png"] }),
    });
    expect(res.status).toBe(404);
  });
});
