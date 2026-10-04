import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findPass: vi.fn(),
  takeSlot: vi.fn(),
  returnSlot: vi.fn(),
  uploadCountOf: vi.fn(),
  addPhoto: vi.fn(),
  storeDocument: vi.fn(),
  processPicture: vi.fn(),
  enforceRateLimit: vi.fn(),
  actorSeen: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/capture/pass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/capture/pass")>()),
  findPass: mocks.findPass,
  takeSlot: mocks.takeSlot,
  returnSlot: mocks.returnSlot,
  uploadCountOf: mocks.uploadCountOf,
}));
vi.mock("@/lib/photos/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/store")>()),
  addPhoto: mocks.addPhoto,
}));
vi.mock("@/lib/documents/store", () => ({ storeDocument: mocks.storeDocument }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock("@/lib/images/process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/process")>()),
  processPicture: mocks.processPicture,
}));

import * as route from "./route";
import { auditStorage } from "@/lib/audit/context";
import { MAX_PHOTO_BYTES, PictureRejected } from "@/lib/images/process";

const TOKEN = "B".repeat(43);
const pass = {
  id: "pass-1",
  entityType: "ammo",
  entityId: "ammo-A",
  createdById: "user-1",
  creatorName: "Ann (@ann)",
  expiresAt: new Date("2026-10-04T12:15:00Z"),
  uploadCount: 4,
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = "%PDF-1.4\n%EOF\n";

function post(fields: Record<string, string | Blob> = {}, opts: { token?: string; ip?: string; omitFile?: boolean } = {}) {
  const token = opts.token ?? TOKEN;
  const form = new FormData();
  if (!opts.omitFile) form.set("file", new File([PNG], "x.png"));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const request = new NextRequest(`http://localhost/api/capture/${token}/upload`, {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": opts.ip ?? "10.1.0.1" },
  });
  return route.POST(request, { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.TRUSTED_PROXIES = "10.0.0.0/8";
  mocks.findPass.mockResolvedValue({ ok: true, pass });
  mocks.takeSlot.mockResolvedValue(true);
  mocks.returnSlot.mockResolvedValue(undefined);
  mocks.uploadCountOf.mockResolvedValue(5);
  mocks.enforceRateLimit.mockResolvedValue({ allowed: true });
  mocks.addPhoto.mockImplementation(async () => {
    mocks.actorSeen(auditStorage.getStore()?.actor);
    return { id: "photo-1" };
  });
  mocks.storeDocument.mockResolvedValue({ id: "doc-1" });
  mocks.processPicture.mockResolvedValue({ bytes: Buffer.from("jpeg"), mimeType: "image/jpeg", extension: "jpg" });
});

describe("POST /api/capture/[token]/upload", () => {
  it("adds a photo to the pass's item and answers 201 with the remaining count", async () => {
    const res = await post({ kind: "photo", label: " Left side " });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ kind: "photo", id: "photo-1", remaining: 45 });
    expect(mocks.addPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ammo",
        entityId: "ammo-A",
        label: "Left side",
        createdById: "user-1",
        viaPass: true,
      }),
    );
  });

  it("records the work under the pass's creator", async () => {
    await post({ kind: "photo" });
    expect(mocks.actorSeen).toHaveBeenCalledWith({
      kind: "user",
      actorId: "user-1",
      actorName: "Ann (@ann)",
      actorIp: "10.1.0.1",
    });
  });

  it("ignores entityType and entityId in the form", async () => {
    const res = await post({ kind: "photo", entityId: "ammo-B", entityType: "firearm", firearmId: "f-1" });
    expect(res.status).toBe(201);
    expect(mocks.addPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.addPhoto.mock.calls[0][0]).toMatchObject({ type: "ammo", entityId: "ammo-A" });
  });

  it("stores paperwork as a Document on the pass's item", async () => {
    const res = await post({ kind: "paperwork", docType: "NFA_TAX_STAMP", name: "  Stamp  ", entityId: "ammo-B" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ kind: "paperwork", id: "doc-1", remaining: 45 });
    expect(mocks.storeDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: Buffer.from("jpeg"),
        extension: "jpg",
        mimeType: "image/jpeg",
        name: "Stamp",
        type: "NFA_TAX_STAMP",
        notes: "Added from a phone capture pass",
        owners: { ammoStockId: "ammo-A" },
        inTransaction: true,
      }),
    );
  });

  it("names unnamed paperwork after its type and the UTC date, defaulting to a receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T23:30:00Z"));
    try {
      await post({ kind: "paperwork" });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.storeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RECEIPT", name: "Receipt 2026-10-04" }),
    );
  });

  it("rejects a PDF as paperwork without taking a slot", async () => {
    const res = await post({ kind: "paperwork", file: new File([PDF], "r.pdf") });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Paperwork from the phone must be a picture." });
    expect(mocks.takeSlot).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown kind", { kind: "video" }, {}],
    ["a missing kind", {}, {}],
    ["a missing file", { kind: "photo" }, { omitFile: true }],
    ["an unknown document type", { kind: "paperwork", docType: "PASSPORT" }, {}],
    ["a label over 80 characters", { kind: "photo", label: "x".repeat(81) }, {}],
    ["a name over 120 characters", { kind: "paperwork", name: "x".repeat(121) }, {}],
  ])("%s answers 400 and takes no slot", async (_why, fields, opts) => {
    const res = await post(fields, opts);
    expect(res.status).toBe(400);
    expect(mocks.takeSlot).not.toHaveBeenCalled();
    expect(mocks.addPhoto).not.toHaveBeenCalled();
    expect(mocks.storeDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["photo", MAX_PHOTO_BYTES + 1],
    ["paperwork", 20 * 1024 * 1024 + 1],
  ])("an oversize %s answers 400 and takes no slot", async (kind, size) => {
    const big = new File([new Uint8Array(size)], "big.jpg");
    const res = await post({ kind, file: big });
    expect(res.status).toBe(400);
    expect(mocks.takeSlot).not.toHaveBeenCalled();
  });

  it("answers 429 when the pass's upload rate is exceeded", async () => {
    mocks.enforceRateLimit.mockResolvedValue({ allowed: false });
    const res = await post({ kind: "photo" });
    expect(res.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith({ key: "capture-upload:pass-1", windowMs: 60_000, maxAttempts: 20 });
    expect(mocks.takeSlot).not.toHaveBeenCalled();
  });

  it("answers 410 full when no slot is left and the pass still reads open", async () => {
    mocks.takeSlot.mockResolvedValue(false);
    const res = await post({ kind: "photo" });
    expect(res.status).toBe(410);
    expect((await res.json()).reason).toBe("full");
    expect(mocks.addPhoto).not.toHaveBeenCalled();
    expect(mocks.returnSlot).not.toHaveBeenCalled();
  });

  it("answers 410 with the pass's own reason when it ended between the checks", async () => {
    mocks.takeSlot.mockResolvedValue(false);
    mocks.findPass.mockResolvedValueOnce({ ok: true, pass }).mockResolvedValueOnce({ ok: false, reason: "closed" });
    const res = await post({ kind: "photo" });
    expect(res.status).toBe(410);
    expect((await res.json()).reason).toBe("closed");
  });

  it("answers 404 for an unknown token", async () => {
    mocks.findPass.mockResolvedValue(null);
    const res = await post({ kind: "photo" });
    expect(res.status).toBe(404);
    expect(mocks.takeSlot).not.toHaveBeenCalled();
  });

  it("a rejected picture answers 400 with its message and returns the slot", async () => {
    mocks.addPhoto.mockRejectedValue(new PictureRejected("NOT_A_PICTURE", "Not a picture."));
    const res = await post({ kind: "photo" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a picture." });
    expect(mocks.returnSlot).toHaveBeenCalledWith("pass-1");
  });

  it("a rejected paperwork picture returns the slot", async () => {
    mocks.processPicture.mockRejectedValue(new PictureRejected("NOT_A_PICTURE", "Not a picture."));
    const res = await post({ kind: "paperwork" });
    expect(res.status).toBe(400);
    expect(mocks.returnSlot).toHaveBeenCalledWith("pass-1");
  });

  it.each([["photo"], ["paperwork"]])("a failed %s write answers 500, returns the slot and logs no token or message", async (kind) => {
    const secret = new Error(`boom ${TOKEN} secret-detail`);
    mocks.addPhoto.mockRejectedValue(secret);
    mocks.storeDocument.mockRejectedValue(secret);
    const logged: unknown[][] = [];
    const spies = (["error", "warn", "log"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void logged.push(a)));
    try {
      const res = await post({ kind });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to upload" });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(mocks.returnSlot).toHaveBeenCalledWith("pass-1");
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
    expect(JSON.stringify(logged)).not.toContain("secret-detail");
  });

  it("exports only POST", () => {
    expect(Object.keys(route)).toEqual(["POST"]);
  });
});
