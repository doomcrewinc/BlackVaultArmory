// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccessoryDetailPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "accessory-1" }),
}));
vi.mock("@/components/photos/PhotoGallery", () => ({
  PhotoGallery: () => null,
}));
vi.mock("@/components/shared/ItemDocumentPanel", () => ({
  ItemDocumentPanel: () => null,
}));
vi.mock("@/components/audit/ItemHistory", () => ({
  ItemHistory: () => null,
}));

const fetchMock = vi.fn();

function accessory(overrides: Record<string, unknown>) {
  return {
    id: "accessory-1",
    name: "Thing",
    manufacturer: "Maker",
    type: "SUPPRESSOR",
    roundCount: 0,
    quantity: 1,
    hasBattery: false,
    fullAutoRating: null,
    fullAutoLimitedTo: null,
    roundCountLogs: [],
    batteryChangeLogs: [],
    currentBuild: null,
    kitAllocation: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function respondWith(record: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url === "/api/accessories/accessory-1" ? record : {}),
  }));
}

describe("accessory detail Full-Auto Rated", () => {
  it.each([
    ["YES", null, "Yes"],
    ["NO", null, "No"],
    ["LIMITED", "5.56 NATO only", "Limited \u2014 5.56 NATO only"],
    [null, null, "Not recorded"],
  ])("shows %s / %s as %s for a suppressor", async (rating, text, shown) => {
    respondWith(accessory({ fullAutoRating: rating, fullAutoLimitedTo: text }));
    render(<AccessoryDetailPage />);

    expect(await screen.findByText("Full-Auto Rated")).toBeInTheDocument();
    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  it("shows nothing for another type", async () => {
    respondWith(accessory({ type: "OPTIC", name: "Scope", fullAutoRating: "YES" }));
    render(<AccessoryDetailPage />);

    await screen.findByText("Scope");
    expect(screen.queryByText("Full-Auto Rated")).toBeNull();
    expect(screen.queryByText("Yes")).toBeNull();
  });
});
