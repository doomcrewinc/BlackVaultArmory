// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ItemHistory } from "./ItemHistory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeEvent(id: string, label: string) {
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

describe("ItemHistory", () => {
  it("fetches the item's events from the item-history endpoint on mount", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ events: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ItemHistory entityType="Firearm" entityId="f1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("/api/admin/audit/item/Firearm/f1");
  });

  it("renders the item's events once loaded", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ events: [makeEvent("e1", "Glock 19")], nextCursor: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ItemHistory entityType="Firearm" entityId="f1" />);
    await waitFor(() => expect(screen.getByText("Glock 19")).toBeTruthy());
  });

  it("shows an empty message when the item has no history", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ events: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ItemHistory entityType="Firearm" entityId="f1" />);
    await waitFor(() => expect(screen.getByText(/no history/i)).toBeTruthy());
  });

  it("loads the next page on Load more, appending to the existing events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [makeEvent("e1", "Glock 19")], nextCursor: "c1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [makeEvent("e2", "AR-15")], nextCursor: null }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ItemHistory entityType="Firearm" entityId="f1" />);
    await waitFor(() => expect(screen.getByText("Glock 19")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(screen.getByText("AR-15")).toBeTruthy());
    expect(screen.getByText("Glock 19")).toBeTruthy();
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=c1");
  });

  it("shows an error message when the fetch fails", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ItemHistory entityType="Firearm" entityId="f1" />);
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeTruthy());
  });

  // Fix round 1, item 9: a failed Load More must not throw away what already
  // loaded successfully.
  it("a failed Load more keeps the already-loaded events visible and shows the error inline, not in place of the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [makeEvent("e1", "Glock 19")], nextCursor: "c1" }) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    render(<ItemHistory entityType="Firearm" entityId="f1" />);
    await waitFor(() => expect(screen.getByText("Glock 19")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeTruthy());
    expect(screen.getByText("Glock 19")).toBeTruthy();
  });
});
