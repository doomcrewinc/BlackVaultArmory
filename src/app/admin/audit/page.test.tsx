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

  // Fix round 1, item 3: the viewer's LOCAL day, not UTC's.
  describe("date filter — local day, not UTC day", () => {
    // Built from LOCAL components, so the expected instant is right in any
    // zone (the CI matrix runs Denver and Auckland) without re-implementing
    // the page's conversion.
    const LOCAL_START_0929 = new Date(2026, 8, 29, 0, 0, 0, 0).toISOString();
    const LOCAL_END_0929 = new Date(2026, 8, 29, 23, 59, 59, 999).toISOString();
    it("sends the viewer's local end-of-day instant for `to`, not the bare UTC day", async () => {
      const fetchMock = auditFetchMock(() => jsonOk({ events: [], nextCursor: null }));
      vi.stubGlobal("fetch", fetchMock);

      render(<AdminAuditPage />);
      await waitFor(() => expect(fetchMock.mock.calls.some((c) => isAuditListCall(String(c[0])))).toBe(true));

      fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: "2026-09-29" } });

      await waitFor(() => expect(replace).toHaveBeenCalled());
      const url = decodeURIComponent(replace.mock.calls[0][0]);
      expect(url).toContain(`to=${LOCAL_END_0929}`);
      expect(url).not.toContain("to=2026-09-29&");
      expect(url.endsWith("to=2026-09-29")).toBe(false);
    });

    it("sends the viewer's local midnight instant for `from`", async () => {
      const fetchMock = auditFetchMock(() => jsonOk({ events: [], nextCursor: null }));
      vi.stubGlobal("fetch", fetchMock);

      render(<AdminAuditPage />);
      await waitFor(() => expect(fetchMock.mock.calls.some((c) => isAuditListCall(String(c[0])))).toBe(true));

      fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: "2026-09-29" } });

      await waitFor(() => expect(replace).toHaveBeenCalled());
      expect(decodeURIComponent(replace.mock.calls[0][0])).toContain(`from=${LOCAL_START_0929}`);
    });

    it("round-trips a full ISO instant already in the URL back to the viewer's local day for the date input", async () => {
      currentSearch = `to=${LOCAL_END_0929}`;
      const fetchMock = auditFetchMock(() => jsonOk({ events: [], nextCursor: null }));
      vi.stubGlobal("fetch", fetchMock);

      render(<AdminAuditPage />);
      await waitFor(() => expect(screen.getByLabelText(/^to$/i)).toHaveValue("2026-09-29"));
    });

    it("the Export CSV link carries the same local-day instant as the fetch, not a bare day", async () => {
      currentSearch = `to=${LOCAL_END_0929}`;
      const fetchMock = auditFetchMock(() => jsonOk({ events: [], nextCursor: null }));
      vi.stubGlobal("fetch", fetchMock);

      render(<AdminAuditPage />);
      await waitFor(() => expect(fetchMock.mock.calls.some((c) => isAuditListCall(String(c[0])))).toBe(true));

      const exportHref = decodeURIComponent(screen.getByRole("link", { name: /export/i }).getAttribute("href") ?? "");
      expect(exportHref).toContain(`to=${LOCAL_END_0929}`);
    });
  });

  // Fix round 1, item 8: a Load More still in flight when the filters change
  // must not append the OLD filter's page, or overwrite `cursor` with a
  // stale value, once the NEW filter's fetch has already landed.
  it("drops a stale Load More response that resolves after the filters have already changed", async () => {
    let resolveStaleLoadMore!: (value: unknown) => void;
    const staleLoadMore = new Promise((resolve) => {
      resolveStaleLoadMore = resolve;
    });

    let call = 0;
    const fetchMock = auditFetchMock((url) => {
      call += 1;
      if (call === 1) return jsonOk({ events: [event("e1", "Glock 19")], nextCursor: "c1" }); // initial page
      if (call === 2) return staleLoadMore; // Load more — held open
      if (url.includes("type=Firearm")) return jsonOk({ events: [event("e3", "AR-15")], nextCursor: null }); // the filter change
      return jsonOk({ events: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<AdminAuditPage />);
    await waitFor(() => expect(screen.getByText("Glock 19")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /load more/i })); // call #2, stalls
    await waitFor(() => expect(call).toBe(2));

    // Simulate the URL having changed (a filter change navigated) and the
    // component re-reading the new searchParams — this fires call #3.
    currentSearch = "type=Firearm";
    rerender(<AdminAuditPage />);
    await waitFor(() => expect(screen.getByText("AR-15")).toBeTruthy());

    // NOW the stale Load More resolves. It must be a no-op.
    resolveStaleLoadMore(jsonOk({ events: [event("e2", "STALE-SHOULD-NOT-APPEAR")], nextCursor: null }));
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("AR-15")).toBeTruthy();
    expect(screen.queryByText("STALE-SHOULD-NOT-APPEAR")).toBeNull();
    expect(screen.queryByText("Glock 19")).toBeNull(); // call #3 replaced the list; it did not append
  });
});
