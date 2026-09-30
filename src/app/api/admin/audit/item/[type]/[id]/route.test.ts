import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  parseAuditFilters: vi.fn(),
  listAuditEvents: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ requireAdmin: m.requireAdmin }));
vi.mock("@/lib/audit/query", () => ({
  parseAuditFilters: m.parseAuditFilters,
  listAuditEvents: m.listAuditEvents,
}));

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
});
