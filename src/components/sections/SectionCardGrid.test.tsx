// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { sectionHref, sectionsForGroup } from "@/lib/categories";
import GearPage from "@/app/gear/page";
import PrepPage from "@/app/prep/page";

const fetchCategoryCounts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/category-counts", () => ({ fetchCategoryCounts }));

afterEach(() => {
  cleanup();
  fetchCategoryCounts.mockReset();
});

function cardFor(label: string): HTMLElement {
  return screen.getByText(label).closest("a") as HTMLElement;
}

/** The card grid: the element that holds the section links. */
function gridOf(container: HTMLElement): HTMLElement {
  return (container.querySelector("a") as HTMLElement).parentElement as HTMLElement;
}

async function flush() {
  await act(async () => {});
}

describe.each([
  ["prep", PrepPage],
  ["gear", GearPage],
] as const)("%s page counts", (group, Page) => {
  const sections = sectionsForGroup(group);
  const [first, second] = sections;

  function expectNoNumbers() {
    for (const section of sections) {
      expect(within(cardFor(section.label)).queryByText(/^\d+$/)).toBeNull();
    }
  }

  it("is busy and shows no number while the counts are loading", async () => {
    fetchCategoryCounts.mockReturnValue(new Promise(() => {}));
    const { container } = render(<Page />);
    await flush();

    expect(gridOf(container)).toHaveAttribute("aria-busy", "true");
    expect(cardFor(first.label)).toHaveAttribute("href", sectionHref(first));
    expectNoNumbers();
  });

  it("shows a real zero and a non-zero once loaded, and is no longer busy", async () => {
    fetchCategoryCounts.mockResolvedValue({
      counts: { [first.slug]: 0, [second.slug]: 7 },
      legacySmgCount: 0,
    });
    const { container } = render(<Page />);
    await flush();

    expect(gridOf(container)).not.toHaveAttribute("aria-busy");
    expect(within(cardFor(second.label)).getByText("7")).toBeInTheDocument();
    expect(within(cardFor(first.label)).getByText("0")).toBeInTheDocument();
  });

  it.each([
    ["the request fails", null],
    ["the body has no counts", { legacySmgCount: 0 }],
  ])("is not busy, shows no numbers and keeps every link when %s", async (_name, result) => {
    fetchCategoryCounts.mockResolvedValue(result);
    const { container } = render(<Page />);
    await flush();

    expect(gridOf(container)).not.toHaveAttribute("aria-busy");
    expectNoNumbers();
    expect(cardFor(first.label)).toHaveAttribute("href", sectionHref(first));
  });

  it("is failed, not stuck loading, when the loader rejects", async () => {
    fetchCategoryCounts.mockRejectedValue(new Error("boom"));
    const { container } = render(<Page />);
    await flush();

    expect(gridOf(container)).not.toHaveAttribute("aria-busy");
    expectNoNumbers();
  });
});
