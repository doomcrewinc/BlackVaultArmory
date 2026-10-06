// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  CATEGORY_SECTIONS,
  sectionBySlug,
  sectionSources,
} from "@/lib/categories";
import type { SectionPayload } from "@/lib/sections/loadSectionItems";
import { SectionView } from "./SectionView";

afterEach(cleanup);

function emptyPayload(kind: "gear" | "supply" | "accessory"): SectionPayload {
  return kind === "accessory"
    ? { kind, items: [] }
    : { kind, items: [], timezoneConfigured: true };
}

const MIXED = CATEGORY_SECTIONS.filter(
  (section) => sectionSources(section).length > 1,
);

const RENDERED = [
  [
    "medical",
    ["Kits & Equipment", "Add Medical Kit", "No medical kits yet"],
    ["Consumable Supplies", "Add Medical Supply", "No medical supplies yet"],
  ],
  [
    "food-water",
    [
      "Water Treatment Equipment",
      "Add Water Treatment Item",
      "No water treatment items yet",
    ],
    [
      "Food, Water & Filters",
      "Add Food or Water Item",
      "No food or water items yet",
    ],
  ],
  [
    "power-comms",
    [
      "Power & Radio Equipment",
      "Add Power or Radio Item",
      "No power or radio items yet",
    ],
    ["Batteries", "Add Battery", "No batteries yet"],
  ],
  [
    "tools-fire",
    [
      "Tools, Lights & Signaling",
      "Add Equipment Item",
      "No equipment items yet",
    ],
    [
      "Fuel & Signal Supplies",
      "Add Fuel or Signal Supply",
      "No fuel or signal supplies yet",
    ],
  ],
  [
    "other-prep",
    ["Other Equipment", "Add Equipment Item", "No equipment items yet"],
    ["Other Consumables", "Add Consumable", "No consumables yet"],
  ],
] as const;

describe("SectionView on a mixed section", () => {
  it("covers every multi-source section", () => {
    expect(RENDERED.map(([slug]) => slug).sort()).toEqual(
      MIXED.map((section) => section.slug).sort(),
    );
  });

  it.each(RENDERED)(
    "%s renders both sub-headings, and each block's Add link carries the section to its own form",
    (slug, gear, supply) => {
      render(
        <SectionView
          section={sectionBySlug(slug)!}
          payloads={[emptyPayload("gear"), emptyPayload("supply")]}
        />,
      );
      const blocks = [
        [gear, `/gear/new?section=${slug}`],
        [supply, `/supplies/new?section=${slug}`],
      ] as const;
      for (const [[heading, add, empty], href] of blocks) {
        expect(
          screen.getByRole("heading", { name: heading }),
        ).toBeInTheDocument();
        const links = screen.getAllByRole("link", { name: add });
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) expect(link).toHaveAttribute("href", href);
        expect(screen.getByText(empty)).toBeInTheDocument();
      }
    },
  );

  it("never shows the storage names as sub-headings", () => {
    render(
      <SectionView
        section={sectionBySlug("medical")!}
        payloads={[emptyPayload("gear"), emptyPayload("supply")]}
      />,
    );
    for (const storage of ["Gear", "Supplies", "Accessories"]) {
      expect(screen.queryByRole("heading", { name: storage })).toBeNull();
    }
  });
});

describe("SectionView on a single-source section", () => {
  it("uses the section's words under the section heading", () => {
    render(
      <SectionView
        section={sectionBySlug("magazines")!}
        payloads={[emptyPayload("accessory")]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Magazines" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add Magazine" })).toHaveAttribute(
      "href",
      "/accessories/new?section=magazines",
    );
    expect(screen.getByText("No magazines yet")).toBeInTheDocument();
  });
});
