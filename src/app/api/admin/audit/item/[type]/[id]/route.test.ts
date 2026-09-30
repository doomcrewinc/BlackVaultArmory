import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  parseAuditFilters: vi.fn(),
  listAuditEvents: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ requireAdmin: m.requireAdmin }));
// Keeps the real hasNulByte: it's exercised for real below, not stubbed.
vi.mock("@/lib/audit/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/query")>();
  return { ...actual, parseAuditFilters: m.parseAuditFilters, listAuditEvents: m.listAuditEvents };
});

import { GET } from "./route";

function context(type: string, id: string) {
  return { params: Promise.resolve({ type, id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.parseAuditFilters.mockReturnValue({});
});

describe("GET /api/admin/audit/item/:type/:id", () => {
  it("401 when signed out", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const res = await GET(new NextRequest("http://localhost/api/admin/audit/item/Firearm/f1"), context("Firearm", "f1"));
    expect(res.status).toBe(401);
    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "Admins only" }, { status: 403 }));
    const res = await GET(new NextRequest("http://localhost/api/admin/audit/item/Firearm/f1"), context("Firearm", "f1"));
    expect(res.status).toBe(403);
    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });

  it("filters by entityType and entityId from the path, merged with query filters (e.g. cursor)", async () => {
    m.requireAdmin.mockResolvedValue(null);
    m.parseAuditFilters.mockReturnValue({ cursor: "c1" });
    m.listAuditEvents.mockResolvedValue({ events: [{ id: "e1" }], nextCursor: null });

    const res = await GET(
      new NextRequest("http://localhost/api/admin/audit/item/Firearm/f1?cursor=c1"),
      context("Firearm", "f1"),
    );

    expect(m.listAuditEvents).toHaveBeenCalledWith({ cursor: "c1", type: "Firearm", entityId: "f1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ id: "e1" }], nextCursor: null });
  });

  it("the path's type overrides any ?type= in the query string", async () => {
    m.requireAdmin.mockResolvedValue(null);
    m.parseAuditFilters.mockReturnValue({ type: "Accessory" });
    m.listAuditEvents.mockResolvedValue({ events: [], nextCursor: null });

    await GET(new NextRequest("http://localhost/api/admin/audit/item/Firearm/f1?type=Accessory"), context("Firearm", "f1"));

    expect(m.listAuditEvents).toHaveBeenCalledWith({ type: "Firearm", entityId: "f1" });
  });

  // Fix round 1, Minor: a NUL byte in either path param would otherwise
  // reach Prisma/Postgres as-is and error 22021 (500). An empty result,
  // not a 500.
  it("returns an empty result, not a 500, for a NUL byte in the path type or id", async () => {
    m.requireAdmin.mockResolvedValue(null);

    const resType = await GET(
      new NextRequest("http://localhost/api/admin/audit/item/x/f1"),
      context("Fire\u0000arm", "f1"),
    );
    expect(resType.status).toBe(200);
    expect(await resType.json()).toEqual({ events: [], nextCursor: null });

    const resId = await GET(new NextRequest("http://localhost/api/admin/audit/item/Firearm/x"), context("Firearm", "f\u00001"));
    expect(resId.status).toBe(200);
    expect(await resId.json()).toEqual({ events: [], nextCursor: null });

    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });
});
