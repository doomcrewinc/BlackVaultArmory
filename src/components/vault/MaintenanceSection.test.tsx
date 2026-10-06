// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MaintenanceSection } from "./MaintenanceSection";

const entry = (id: string, date: string, notes: string) => ({
  id,
  date: `${date}T00:00:00.000Z`,
  notes,
  roundCount: null,
  createdAt: `${date}T12:00:00.000Z`,
});

function renderCard(logs: ReturnType<typeof entry>[]) {
  return render(
    <MaintenanceSection
      firearmId="f1"
      lastMaintenanceDate="2026-07-03T00:00:00.000Z"
      maintenanceIntervalDays={90}
      initialLogs={logs}
    />,
  );
}

beforeEach(() => {
  // The evening of 5 October in the pinned zone.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T01:47:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MaintenanceSection", () => {
  it("with no entry since, the stored date stands and the service is due", () => {
    renderCard([]);
    expect(screen.getByText("Jul 3, 2026")).toBeTruthy();
    expect(screen.getByText("Oct 1, 2026")).toBeTruthy();
    expect(screen.getByText("Due")).toBeTruthy();
  });

  it("a logged entry counts as the last service: no longer due, next due 90 days on", () => {
    renderCard([entry("e1", "2026-10-01", "Cleaned and Oiled")]);
    expect(screen.queryByText("Due")).toBeNull();
    expect(screen.getByText("On Track")).toBeTruthy();
    expect(screen.getByText("Dec 30, 2026")).toBeTruthy();
    expect(screen.queryByText("Jul 3, 2026")).toBeNull();
  });

  it("deleting that entry falls back to the stored date", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    renderCard([entry("e1", "2026-10-01", "Cleaned and Oiled")]);
    fireEvent.click(screen.getByRole("button", { name: /maintenance log/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^(yes|confirm|delete)$/i }));
    await waitFor(() => expect(screen.getAllByText("Jul 3, 2026").length).toBeGreaterThan(0));
    expect(screen.getByText("Due")).toBeTruthy();
  });
});
