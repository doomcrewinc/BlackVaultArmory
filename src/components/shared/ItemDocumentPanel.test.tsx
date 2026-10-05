// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { announceItemAttachmentsChanged } from "@/lib/photos/client-constants";
import { ItemDocumentPanel } from "./ItemDocumentPanel";

function doc(id: string, title: string) {
  return {
    id,
    name: title,
    type: "RECEIPT",
    fileUrl: `/uploads/documents/${id}.pdf`,
    mimeType: "application/pdf",
    fileSize: 100,
    createdAt: "2026-10-04T00:00:00.000Z",
  };
}

function stubDocuments(first: unknown[], later: unknown[]) {
  let calls = 0;
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => (++calls === 1 ? first : later),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ItemDocumentPanel reload on attachments changed", () => {
  it("fetches again when its own item announces a change", async () => {
    const fetchMock = stubDocuments([], [doc("d1", "Receipt from phone")]);
    render(<ItemDocumentPanel entityType="firearm" entityId="f1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/documents?firearmId=f1");

    act(() => announceItemAttachmentsChanged({ entityType: "firearm", entityId: "f1" }));

    expect(await screen.findByText("Receipt from phone")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["another item", { entityType: "firearm", entityId: "f2" }],
    ["another type with the same id", { entityType: "gear", entityId: "f1" }],
  ] as const)("ignores a change announced for %s", async (_name, detail) => {
    const fetchMock = stubDocuments([], [doc("d1", "Should not show")]);
    render(<ItemDocumentPanel entityType="firearm" entityId="f1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => announceItemAttachmentsChanged(detail));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Should not show")).toBeNull();
  });

  it("stops listening once it is unmounted", async () => {
    const fetchMock = stubDocuments([], []);
    const { unmount } = render(<ItemDocumentPanel entityType="firearm" entityId="f1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();

    announceItemAttachmentsChanged({ entityType: "firearm", entityId: "f1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
