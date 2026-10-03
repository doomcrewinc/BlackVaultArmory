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

function get(url = "http://localhost/api/admin/audit/export") {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/audit/export", () => {
  it("401 when signed out", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });

  it("403 Admins only for a USER", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "Admins only" }, { status: 403 }));
    const res = await GET(get());
    expect(res.status).toBe(403);
    expect(m.listAuditEvents).not.toHaveBeenCalled();
  });

  it("drains every page with the cursor and streams them as one CSV", async () => {
    m.requireAdmin.mockResolvedValue(null);
    m.parseAuditFilters.mockReturnValue({ type: "Firearm" });
    const ev = (label: string) => ({
      id: label, at: "2026-03-05T00:00:00.000Z", actorId: null, actorName: "system", actorIp: null,
      action: "CREATE", entityType: "Firearm", entityId: label, entityLabel: label, changes: null,
    });
    m.listAuditEvents
      .mockResolvedValueOnce({ events: [ev("e1")], nextCursor: "c1" })
      .mockResolvedValueOnce({ events: [ev("e2")], nextCursor: null });

    const res = await GET(get("http://localhost/api/admin/audit/export?type=Firearm"));

    expect(await res.text()).toBe(
      "at,actor,ip,action,type,item,changes\r\n" +
        "2026-03-05T00:00:00.000Z,system,,CREATE,Firearm,e1,\r\n" +
        "2026-03-05T00:00:00.000Z,system,,CREATE,Firearm,e2,",
    );
    expect(m.listAuditEvents).toHaveBeenNthCalledWith(1, { type: "Firearm", cursor: undefined }, 500);
    expect(m.listAuditEvents).toHaveBeenNthCalledWith(2, { type: "Firearm", cursor: "c1" }, 500);
    expect(m.listAuditEvents).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one query when there is only one page", async () => {
    m.requireAdmin.mockResolvedValue(null);
    m.parseAuditFilters.mockReturnValue({});
    m.listAuditEvents.mockResolvedValue({ events: [], nextCursor: null });

    await GET(get());

    expect(m.listAuditEvents).toHaveBeenCalledTimes(1);
  });

  it("sets the CSV content type and a dated attachment filename", async () => {
    m.requireAdmin.mockResolvedValue(null);
    m.parseAuditFilters.mockReturnValue({});
    m.listAuditEvents.mockResolvedValue({ events: [], nextCursor: null });

    const res = await GET(get());

    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="blackvault-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  it("ignores a cursor already present in the query string and always starts from the newest row", async () => {
    m.requireAdmin.mockResolvedValue(null);
    m.parseAuditFilters.mockReturnValue({ cursor: "existing", type: "Firearm" });
    m.listAuditEvents.mockResolvedValue({ events: [], nextCursor: null });

    await GET(get("http://localhost/api/admin/audit/export?cursor=existing&type=Firearm"));

    expect(m.listAuditEvents).toHaveBeenCalledWith({ type: "Firearm", cursor: undefined }, 500);
  });
});
