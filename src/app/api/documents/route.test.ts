import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/auth", () => ({
  requireAuth: async () => null,
  requireAdmin: async () => null,
  getCurrentUser: async () => ({ id: "u1", username: "admin", displayName: "Admin", role: "ADMIN", sessionId: "s1" }),
}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    document: {
      findMany: mocks.findMany,
      create: mocks.create,
    },
  },
}));

import { GET, POST } from "./route";

function getRequest(query = "") {
  return new NextRequest(`http://localhost/api/documents${query}`);
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("filters by gearId when provided", async () => {
    await GET(getRequest("?gearId=g1"));

    const { where, include } = mocks.findMany.mock.calls[0][0];
    expect(where).toEqual({ gearId: "g1" });
    expect(include.gear).toEqual({ select: { id: true, name: true } });
  });

  it.each([
    ["ammoStockId", "a1"],
    ["supplyId", "s1"],
    ["kitId", "k1"],
  ])("filters by %s when provided", async (key, value) => {
    await GET(getRequest(`?${key}=${value}`));

    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ [key]: value });
  });

  it("includes the ammunition, supply and kit relations", async () => {
    await GET(getRequest());

    const { include } = mocks.findMany.mock.calls[0][0];
    expect(include.ammoStock).toEqual({ select: { id: true, caliber: true, brand: true } });
    expect(include.supply).toEqual({ select: { id: true, name: true } });
    expect(include.kit).toEqual({ select: { id: true, name: true } });
  });

  it("applies no filter when no query params are given", async () => {
    await GET(getRequest());

    const { where } = mocks.findMany.mock.calls[0][0];
    expect(where).toEqual({});
  });
});

describe("POST /api/documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: "doc1" });
  });

  it("stores gearId when provided", async () => {
    await POST(
      postRequest({
        name: "Warranty card",
        fileUrl: "/api/files/documents/abc.pdf",
        gearId: "g1",
      }),
    );

    const { data, include } = mocks.create.mock.calls[0][0];
    expect(data.gearId).toBe("g1");
    expect(data.firearmId).toBeNull();
    expect(data.accessoryId).toBeNull();
    expect(include.gear).toEqual({ select: { id: true, name: true } });
  });

  it("stores firearmId, accessoryId, and gearId as null when no entity id is given", async () => {
    await POST(
      postRequest({
        name: "Unattached receipt",
        fileUrl: "/api/files/documents/xyz.pdf",
      }),
    );

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.firearmId).toBeNull();
    expect(data.accessoryId).toBeNull();
    expect(data.gearId).toBeNull();
  });

  it("stores the ammunition, supply and kit owners", async () => {
    await POST(
      postRequest({
        name: "Lot sheet",
        fileUrl: "/api/files/documents/abc.pdf",
        ammoStockId: "a1",
        supplyId: "s1",
        kitId: "k1",
      }),
    );

    const { data, include } = mocks.create.mock.calls[0][0];
    expect(data).toMatchObject({ ammoStockId: "a1", supplyId: "s1", kitId: "k1" });
    expect(include.kit).toEqual({ select: { id: true, name: true } });
  });

  it("stores the new owner ids as null when none is given", async () => {
    await POST(postRequest({ name: "Loose", fileUrl: "/api/files/documents/xyz.pdf" }));

    const { data } = mocks.create.mock.calls[0][0];
    expect(data).toMatchObject({ ammoStockId: null, supplyId: null, kitId: null });
  });

  it("requires name and fileUrl", async () => {
    const response = await POST(postRequest({ gearId: "g1" }));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
