// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AccessoriesClientPage } from "./AccessoriesClientPage";

afterEach(cleanup);

function row(
  fullAutoRating: string | null | undefined,
  fullAutoLimitedTo: string | null = null,
  type = "SUPPRESSOR",
) {
  return {
    id: "a1",
    name: "Quiet Can",
    manufacturer: "Maker",
    model: null,
    type,
    roundCount: 0,
    quantity: 1,
    fullAutoRating,
    fullAutoLimitedTo,
    imageUrl: null,
    purchasePrice: null,
    acquisitionDate: null,
    currentBuild: null,
  };
}

// The list renders a card layout and a table layout and hides one with CSS,
// so each badge appears once in each.
describe("accessory list full-auto badges", () => {
  it("tags a Yes suppressor", () => {
    render(<AccessoriesClientPage accessories={[row("YES")]} />);
    expect(screen.getAllByText("Full-Auto Rated")).toHaveLength(2);
    expect(screen.queryByText("Full-Auto: Limited")).toBeNull();
  });

  it("tags a Limited suppressor differently, with the limit as title and as visible text", () => {
    render(<AccessoriesClientPage accessories={[row("LIMITED", "5.56 NATO only")]} />);
    const badges = screen.getAllByText("Full-Auto: Limited");
    expect(badges).toHaveLength(2);
    for (const badge of badges) expect(badge).toHaveAttribute("title", "5.56 NATO only");
    expect(screen.getAllByText("5.56 NATO only")).toHaveLength(2);
    expect(screen.queryByText("Full-Auto Rated")).toBeNull();
  });

  it.each([
    ["NO", "NO"],
    ["null", null],
    ["absent", undefined],
  ])("shows no badge when the rating is %s", (_label, rating) => {
    render(<AccessoriesClientPage accessories={[row(rating, "stale text")]} />);
    expect(screen.queryByText("Full-Auto Rated")).toBeNull();
    expect(screen.queryByText("Full-Auto: Limited")).toBeNull();
    expect(screen.queryByText("stale text")).toBeNull();
  });

  it.each([
    ["YES", null],
    ["LIMITED", "5.56 NATO only"],
  ])("shows no badge for an optic that holds a stray %s", (rating, text) => {
    render(<AccessoriesClientPage accessories={[row(rating, text, "OPTIC")]} />);
    expect(screen.queryByText("Full-Auto Rated")).toBeNull();
    expect(screen.queryByText("Full-Auto: Limited")).toBeNull();
    expect(screen.queryByText("5.56 NATO only")).toBeNull();
  });

  it("prints a long limit in full, wrapping rather than truncating, with a title", () => {
    const limit = "5.56 NATO and 300 BLK subsonic and supersonic, short barrels only, no belt-fed use ".repeat(2).trim();
    render(<AccessoriesClientPage accessories={[row("LIMITED", limit)]} />);
    for (const text of screen.getAllByText(limit)) {
      expect(text).toHaveAttribute("title", limit);
      expect(text.className).not.toContain("truncate");
    }
  });
});
