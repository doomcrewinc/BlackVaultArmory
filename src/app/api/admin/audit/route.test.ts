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

function get(url = "http://localhost/api/admin/audit") {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/audit", () => {
  it("401 when signed out", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(m.parseAuditFilters).not.toHaveBeenCalled();
    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "Admins only" }, { status: 403 }));
    const res = await GET(get());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });

  it("parses filters from the query string and returns events + nextCursor for an admin", async () => {
    m.requireAdmin.mockResolvedValue(null);
    const filters = { user: "u1" };
    m.parseAuditFilters.mockReturnValue(filters);
    m.listAuditEvents.mockResolvedValue({ events: [{ id: "e1" }], nextCursor: "cursor1" });

    const res = await GET(get("http://localhost/api/admin/audit?user=u1"));

    expect(m.parseAuditFilters).toHaveBeenCalledTimes(1);
    expect(m.parseAuditFilters.mock.calls[0][0]).toBeInstanceOf(URLSearchParams);
    expect(m.parseAuditFilters.mock.calls[0][0].get("user")).toBe("u1");
    expect(m.listAuditEvents).toHaveBeenCalledWith(filters);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ id: "e1" }], nextCursor: "cursor1" });
  });
});
