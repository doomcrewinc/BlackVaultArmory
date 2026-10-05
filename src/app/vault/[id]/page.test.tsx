// @vitest-environment jsdom
/**
 * ADMIN-only gating of the item History section: the page calls
 * getCurrentUser() itself (server-side) and only includes <ItemHistory> in
 * its JSX for an ADMIN — a USER's render tree never mounts it, so it never
 * fetches the audit API on their behalf. This is a server component: it is
 * called directly as an async function and its resolved JSX rendered, the
 * standard way to test an RSC with Vitest + Testing Library.
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "UI" — resolution
 * in task-7-brief.md.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  findUnique: vi.fn(),
  getItemAllocation: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({ getCurrentUser: m.getCurrentUser }));
vi.mock("@/lib/prisma", () => ({ prisma: { firearm: { findUnique: m.findUnique } } }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/kits/itemAllocation", () => ({ getItemAllocation: m.getItemAllocation }));

import FirearmDetailPage from "./page";

const FIREARM = {
  id: "f1",
  name: "Glock 19",
  manufacturer: "Glock",
  model: "19",
  type: "PISTOL",
  caliber: "9mm",
  serialNumber: "ABC123",
  imageUrl: null,
  nfaClass: "NONE",
  mgRegistry: null,
  nfaTransferMethod: null,
  nfaControlNumber: null,
  nfaApprovalDate: null,
  nfaTaxPaid: null,
  nfaRegisteredTo: null,
  notes: null,
  acquisitionDate: null,
  purchasePrice: null,
  currentValue: null,
  lastMaintenanceDate: null,
  maintenanceIntervalDays: null,
  rangeSessions: [],
  documents: [],
  maintenanceLogs: [],
  builds: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderPage() {
  const jsx = await FirearmDetailPage({ params: Promise.resolve({ id: "f1" }) });
  render(jsx);
}

describe("FirearmDetailPage — History section admin gating", () => {
  it("renders History and fetches it for an ADMIN", async () => {
    m.getCurrentUser.mockResolvedValue({ id: "u1", role: "ADMIN" });
    m.findUnique.mockResolvedValue(FIREARM);
    m.getItemAllocation.mockResolvedValue(null);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ events: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetchMock);

    await renderPage();

    expect(screen.getByText("History")).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/admin/audit/item/Firearm/f1"))).toBe(true),
    );
  });

  it("never renders History and never fetches it for a USER", async () => {
    m.getCurrentUser.mockResolvedValue({ id: "u2", role: "USER" });
    m.findUnique.mockResolvedValue(FIREARM);
    m.getItemAllocation.mockResolvedValue(null);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ events: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetchMock);

    await renderPage();

    expect(screen.queryByText("History")).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/admin/audit/item"))).toBe(false);
  });

  it("never renders History when no one is signed in", async () => {
    m.getCurrentUser.mockResolvedValue(null);
    m.findUnique.mockResolvedValue(FIREARM);
    m.getItemAllocation.mockResolvedValue(null);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ events: [], nextCursor: null }) }));
    vi.stubGlobal("fetch", fetchMock);

    await renderPage();

    expect(screen.queryByText("History")).toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/admin/audit/item"))).toBe(false);
  });
});
