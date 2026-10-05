import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  findOwnerName: vi.fn(),
  record: vi.fn(),
  passFindUnique: vi.fn(),
  passUpdateMany: vi.fn(),
  photoFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  kitFindUnique: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/audit/events", () => ({ recordEventBestEffort: mocks.record }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    capturePass: { findUnique: mocks.passFindUnique, updateMany: mocks.passUpdateMany },
    photo: { findMany: mocks.photoFindMany },
    document: { findMany: mocks.documentFindMany },
    kit: { findUnique: mocks.kitFindUnique },
  },
}));
vi.mock("@/lib/photos/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/photos/owner")>()),
  findOwnerName: mocks.findOwnerName,
}));

import { DELETE, GET } from "./route";

const created = new Date(Date.now() - 60_000);
const pass = {
  id: "pass1",
  entityType: "kit",
  entityId: "k1",
  createdById: "u1",
  createdAt: created,
  expiresAt: new Date(Date.now() + 14 * 60_000),
  closedAt: null as Date | null,
  uploadCount: 3,
};
const photo = {
  id: "ph1",
  fileName: "ph1.jpg",
  fileSize: 4,
  width: 2,
  height: 2,
  label: "front",
  viaPass: true,
  createdAt: new Date(),
};

const ctx = { params: Promise.resolve({ id: "pass1" }) };
const get = () => GET(new NextRequest("http://localhost/api/capture-passes/pass1"), ctx);
const del = () => DELETE(new NextRequest("http://localhost/api/capture-passes/pass1", { method: "DELETE" }), ctx);
const as = (id: string, role = "USER") =>
  mocks.getCurrentUser.mockResolvedValue({ id, username: id, displayName: id, role, sessionId: "s" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  as("u1");
  mocks.passFindUnique.mockResolvedValue({ ...pass });
  mocks.passUpdateMany.mockResolvedValue({ count: 1 });
  mocks.findOwnerName.mockResolvedValue("Range kit");
  mocks.photoFindMany.mockResolvedValue([photo]);
  mocks.documentFindMany.mockResolvedValue([{ id: "d1", name: "Receipt", type: "RECEIPT", createdAt: new Date("2026-10-04T00:00:00Z") }]);
  mocks.kitFindUnique.mockResolvedValue({ imageUrl: "/uploads/images/photos/ph1.jpg" });
});

describe("GET /api/capture-passes/[id]", () => {
  it("is 401 without a session", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it("is 404 for a missing pass", async () => {
    mocks.passFindUnique.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it.each([["another user", "u2", "USER"], ["an admin", "root", "ADMIN"]])("is 404 for %s", async (_l, id, role) => {
    as(id, role);
    expect((await get()).status).toBe(404);
    expect(mocks.photoFindMany).not.toHaveBeenCalled();
  });

  it("returns state and what arrived since the pass was made", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "open", uploadCount: 3, remaining: 47 });
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toMatchObject({ id: "ph1", viaPass: true, isMain: true });
    expect(body.documents).toEqual([{ id: "d1", name: "Receipt", type: "RECEIPT", createdAt: "2026-10-04T00:00:00.000Z" }]);
    expect(mocks.photoFindMany.mock.calls[0][0].where).toEqual({ kitId: "k1", viaPass: true, createdAt: { gte: created } });
    expect(mocks.documentFindMany.mock.calls[0][0].where).toEqual({ kitId: "k1", createdAt: { gte: created } });
  });

  it.each([
    ["closed", { closedAt: new Date() }],
    ["expired", { expiresAt: new Date(Date.now() - 1000) }],
    ["full", { uploadCount: 50 }],
  ])("reports %s", async (status, over) => {
    mocks.passFindUnique.mockResolvedValue({ ...pass, ...over });
    const body = await (await get()).json();
    expect(body.status).toBe(status);
  });
});

describe("DELETE /api/capture-passes/[id]", () => {
  it("is 401 without a session", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    expect((await del()).status).toBe(401);
  });

  it("is 404 for a missing pass", async () => {
    mocks.passFindUnique.mockResolvedValue(null);
    expect((await del()).status).toBe(404);
  });

  it("is 403 for another non-admin, and closes nothing", async () => {
    as("u2");
    expect((await del()).status).toBe(403);
    expect(mocks.passUpdateMany).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([["the creator", "u1", "USER"], ["an admin", "root", "ADMIN"]])("closes the pass for %s and audits it", async (_l, id, role) => {
    as(id, role);
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mocks.passUpdateMany.mock.calls[0][0].where).toEqual({ id: "pass1", closedAt: null });
    const [client, event] = mocks.record.mock.calls[0];
    expect(client).toBeNull();
    expect(event).toMatchObject({
      action: "CAPTURE_PASS_CLOSED",
      entityType: "Kit",
      entityId: "k1",
      entityLabel: "Range kit",
      changes: { passId: "pass1" },
    });
  });

  it("is a quiet success without an audit event when the pass was already closed", async () => {
    mocks.passUpdateMany.mockResolvedValue({ count: 0 });
    expect((await del()).status).toBe(200);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
