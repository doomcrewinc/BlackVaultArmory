// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/admin/audit",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

import AdminAuditPage from "./page";

function event(id: string, label: string) {
  return {
    id,
    at: "2026-09-29T12:00:00.000Z",
    actorId: "u1",
    actorName: "Jeff (@jeff)",
    actorIp: null,
    action: "UPDATE",
    entityType: "Firearm",
    entityId: "f1",
    entityLabel: label,
    changes: { status: ["Active", "Sold"] },
  };
}

const USERS_RESPONSE = { ok: true, json: async () => ({ users: [] }) };

/** AuditFilters fetches /api/admin/users on its own, independent of the page's own audit fetch — every test's fetch mock must answer both, dispatched by URL rather than call order. */
function auditFetchMock(handleAudit: (url: string) => unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/users")) return USERS_RESPONSE;
    return handleAudit(url);
  });
}

function jsonOk(body: unknown) {
  return { ok: true, json: async () => body };
}

/** Matches only the list endpoint (`/api/admin/audit` or `/api/admin/audit?...`), never `/export` or `/item/...`. */
function isAuditListCall(url: string): boolean {
  return /^\/api\/admin\/audit(\?.*)?$/.test(url);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockClear();
  currentSearch = "";
});

describe("AdminAuditPage", () => {
  it("loads events for the filters already in the URL on mount", async () => {
    currentSearch = "type=Firearm";
    const fetchMock = auditFetchMock(() => jsonOk({ events: [event("e1", "Glock 19")], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminAuditPage />);

    await waitFor(() => expect(screen.getByText("Glock 19")).toBeTruthy());
    const auditCall = fetchMock.mock.calls.map((c) => String(c[0])).find(isAuditListCall);
    expect(auditCall).toContain("type=Firearm");
  });

  it("changing a filter updates the query string via router.replace", async () => {
    const fetchMock = auditFetchMock(() => jsonOk({ events: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminAuditPage />);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => isAuditListCall(String(c[0])))).toBe(true));

    fireEvent.change(screen.getByLabelText(/^action$/i), { target: { value: "deletes" } });

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0][0]).toContain("action=deletes");
  });

  it("builds the Export CSV link with the current filters", async () => {
    currentSearch = "type=Firearm&action=edits";
    const fetchMock = auditFetchMock(() => jsonOk({ events: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminAuditPage />);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => isAuditListCall(String(c[0])))).toBe(true));

    const exportLink = screen.getByRole("link", { name: /export/i });
    expect(exportLink.getAttribute("href")).toContain("/api/admin/audit/export");
    expect(exportLink.getAttribute("href")).toContain("type=Firearm");
    expect(exportLink.getAttribute("href")).toContain("action=edits");
  });

  it("Load more fetches the next page by cursor without touching the URL", async () => {
    let call = 0;
    const fetchMock = auditFetchMock(() => {
      call += 1;
      return call === 1
        ? jsonOk({ events: [event("e1", "Glock 19")], nextCursor: "c1" })
        : jsonOk({ events: [event("e2", "AR-15")], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminAuditPage />);
    await waitFor(() => expect(screen.getByText("Glock 19")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getByText("AR-15")).toBeTruthy());

    const secondAuditCall = fetchMock.mock.calls.map((c) => String(c[0])).filter(isAuditListCall)[1];
    expect(secondAuditCall).toContain("cursor=c1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows an error message when the fetch fails", async () => {
    const fetchMock = auditFetchMock(() => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminAuditPage />);
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeTruthy());
  });
});
