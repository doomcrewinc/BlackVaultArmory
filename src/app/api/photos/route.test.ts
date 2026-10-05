import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforceRateLimit: vi.fn(),
  findOwnerName: vi.fn(),
  addPhoto: vi.fn(),
  photoFindMany: vi.fn(),
  itemFindUnique: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: mocks.requireAuth,
  getCurrentUser: async () => ({ id: "u1", username: "a", displayName: "A", role: "USER", sessionId: "s1" }),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    photo: { findMany: mocks.photoFindMany },
    gear: { findUnique: mocks.itemFindUnique },
  },
}));
vi.mock("@/lib/photos/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/owner")>()),
  findOwnerName: mocks.findOwnerName,
}));
vi.mock("@/lib/photos/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/store")>()),
  addPhoto: mocks.addPhoto,
}));

import { GET, POST } from "./route";
import { MAX_PHOTO_BYTES, PictureRejected } from "@/lib/images/process";
import { UPLOADS_NOT_WRITABLE_MESSAGE } from "@/lib/photos/errors";

const row = {
  id: "p1",
  fileName: "p1.jpg",
  fileSize: 4,
  width: 2,
  height: 2,
  label: null,
  viaPass: false,
  createdAt: new Date("2026-10-04T00:00:00Z"),
};

function getReq(query: string) {
  return new NextRequest(`http://localhost/api/photos${query}`);
}

function postReq(fields: Record<string, string>, file: File | null = new File([new Uint8Array([1, 2])], "a.jpg")) {
  const form = new FormData();
  if (file) form.set("file", file);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new NextRequest("http://localhost/api/photos", { method: "POST", body: form });
}

const valid = { entityType: "gear", entityId: "g1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireAuth.mockResolvedValue(null);
  mocks.enforceRateLimit.mockResolvedValue({ allowed: true });
  mocks.findOwnerName.mockResolvedValue("Bag");
  mocks.itemFindUnique.mockResolvedValue({ imageUrl: "/uploads/images/photos/p1.jpg" });
  mocks.photoFindMany.mockResolvedValue([row, { ...row, id: "p2", fileName: "p2.jpg" }]);
  mocks.addPhoto.mockResolvedValue(row);
});

const permissionError = (code: string) => Object.assign(new Error("secret-detail"), { code });

describe("POST /api/photos when the uploads folder is not writable", () => {
  it.each(["EACCES", "EPERM", "EROFS"])("%s answers 500 with the permissions message", async (code) => {
    mocks.addPhoto.mockRejectedValue(permissionError(code));
    const res = await POST(postReq(valid));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: UPLOADS_NOT_WRITABLE_MESSAGE });
  });

  it("any other failure keeps the plain message", async () => {
    mocks.addPhoto.mockRejectedValue(permissionError("ENOSPC"));
    const res = await POST(postReq(valid));
    expect(await res.json()).toEqual({ error: "Failed to upload photo" });
  });
});

describe("GET /api/photos", () => {
  it("is refused without a session", async () => {
    mocks.requireAuth.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }));
    expect((await GET(getReq("?entityType=gear&entityId=g1"))).status).toBe(401);
  });

  it.each([
    ["?entityType=build&entityId=g1"],
    ["?entityId=g1"],
    ["?entityType=gear&entityId=../x"],
    ["?entityType=gear"],
  ])("rejects %s with 400", async (query) => {
    expect((await GET(getReq(query))).status).toBe(400);
  });

  it("404s when the item does not exist", async () => {
    mocks.findOwnerName.mockResolvedValue(null);
    expect((await GET(getReq("?entityType=gear&entityId=g1"))).status).toBe(404);
  });

  it("lists photos oldest first and marks the main picture", async () => {
    const res = await GET(getReq("?entityType=gear&entityId=g1"));
    const body = await res.json();

    expect(mocks.photoFindMany).toHaveBeenCalledWith({ where: { gearId: "g1" }, orderBy: { createdAt: "asc" } });
    expect(body.photos.map((p: { id: string; isMain: boolean }) => [p.id, p.isMain])).toEqual([
      ["p1", true],
      ["p2", false],
    ]);
  });
});

describe("failure logging", () => {
  const boom = Object.assign(new Error("MARKER-secret"), { code: "ENOSPC" });

  it.each([
    ["GET", () => GET(getReq("?entityType=gear&entityId=g1")), () => mocks.photoFindMany.mockRejectedValueOnce(boom)],
    ["POST", () => POST(postReq(valid)), () => mocks.addPhoto.mockRejectedValueOnce(boom)],
  ])("%s logs the error name and code, not its message", async (_n, call, fail) => {
    fail();

    expect((await call()).status).toBe(500);

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("Error ENOSPC");
    expect(logged).not.toContain("MARKER-secret");
  });
});

describe("POST /api/photos", () => {
  it("is refused without a session", async () => {
    mocks.requireAuth.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }));
    expect((await POST(postReq(valid))).status).toBe(401);
  });

  it("429s when the upload rate is exceeded, keyed by user", async () => {
    mocks.enforceRateLimit.mockResolvedValue({ allowed: false });
    expect((await POST(postReq(valid))).status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith({
      key: "upload:photos:u:u1",
      windowMs: 60_000,
      maxAttempts: 20,
    });
  });

  it.each([
    ["no file", valid, null],
    ["bad entityType", { ...valid, entityType: "build" }, undefined],
    ["unsafe entityId", { ...valid, entityId: "a/b" }, undefined],
    ["label over 80", { ...valid, label: "x".repeat(81) }, undefined],
  ])("400s on %s", async (_name, fields, file) => {
    const res = await POST(postReq(fields, file));
    expect(res.status).toBe(400);
    expect(mocks.addPhoto).not.toHaveBeenCalled();
  });

  it("says why a label is rejected", async () => {
    const res = await POST(postReq({ ...valid, label: "x".repeat(81) }));
    expect((await res.json()).error).toBe("Label is too long (80 characters at most).");
  });

  it("400s on an oversize file before reading its body", async () => {
    const big = new File([new Uint8Array([1])], "big.jpg");
    Object.defineProperty(big, "size", { value: MAX_PHOTO_BYTES + 1 });
    const arrayBuffer = vi.spyOn(big, "arrayBuffer");
    const req = postReq(valid, null);
    vi.spyOn(req, "formData").mockResolvedValue(
      Object.assign(new FormData(), {
        get: (k: string) => ({ file: big, ...valid })[k] ?? null,
      }) as FormData,
    );

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("File too large. Maximum size is 25MB.");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("404s when the item does not exist", async () => {
    mocks.findOwnerName.mockResolvedValue(null);
    expect((await POST(postReq(valid))).status).toBe(404);
    expect(mocks.addPhoto).not.toHaveBeenCalled();
  });

  it("stores the photo and answers 201 with its dto", async () => {
    const res = await POST(postReq({ ...valid, label: " front " }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mocks.addPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "gear",
        entityId: "g1",
        label: "front",
        createdById: "u1",
        viaPass: false,
      }),
    );
    expect(body.photo).toMatchObject({ id: "p1", url: "/uploads/images/photos/p1.jpg" });
  });

  it("passes a rejected picture's message through as 400", async () => {
    mocks.addPhoto.mockRejectedValue(new PictureRejected("NOT_A_PICTURE", "not readable"));
    const res = await POST(postReq(valid));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not readable");
  });

  it("500s on an unknown error without logging request data", async () => {
    mocks.addPhoto.mockRejectedValue(new Error("secret internals"));
    const res = await POST(postReq(valid));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("POST /api/photos failed:", "Error");
  });
});
