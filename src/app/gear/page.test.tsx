// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { sectionHref, sectionsForGroup } from "@/lib/categories";
import type { CategoryCounts } from "@/lib/category-counts";
import GearPage from "./page";

const fetchCategoryCounts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/category-counts", () => ({ fetchCategoryCounts }));

afterEach(() => {
  cleanup();
  fetchCategoryCounts.mockReset();
});

function cardFor(label: string): HTMLElement {
  return screen.getByText(label).closest("a") as HTMLElement;
}

function countsFor(slugValues: Record<string, number>): CategoryCounts {
  return { counts: slugValues, legacySmgCount: 0 };
}

describe("Gear page counts", () => {
  const [first, second] = sectionsForGroup("gear");

  it("shows no number while the counts are loading", () => {
    fetchCategoryCounts.mockReturnValue(new Promise(() => {}));
    render(<GearPage />);

    expect(cardFor(first.label)).toHaveAttribute("href", sectionHref(first));
    expect(within(cardFor(first.label)).queryByText(/^\d+$/)).toBeNull();
    expect(within(cardFor(second.label)).queryByText(/^\d+$/)).toBeNull();
  });

  it("shows a real zero and a non-zero once loaded", async () => {
    fetchCategoryCounts.mockResolvedValue(countsFor({ [first.slug]: 0, [second.slug]: 7 }));
    render(<GearPage />);

    await waitFor(() => expect(within(cardFor(second.label)).getByText("7")).toBeInTheDocument());
    expect(within(cardFor(first.label)).getByText("0")).toBeInTheDocument();
  });

  it("shows no numbers and still lists every section when the load fails", async () => {
    fetchCategoryCounts.mockResolvedValue(null);
    render(<GearPage />);

    await waitFor(() => expect(fetchCategoryCounts).toHaveBeenCalled());
    await Promise.resolve();
    for (const section of sectionsForGroup("gear")) {
      expect(within(cardFor(section.label)).queryByText(/^\d+$/)).toBeNull();
    }
  });
});
