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

describe("SectionView on a mixed section", () => {
  it.each(MIXED.map((section) => [section.slug, section] as const))(
    "%s gives each block a plain sub-heading and its own Add button",
    (_slug, section) => {
      render(
        <SectionView
          section={section}
          payloads={[emptyPayload("gear"), emptyPayload("supply")]}
        />,
      );
      for (const kind of ["gear", "supply"] as const) {
        const block = section.blocks![kind]!;
        expect(
          screen.getByRole("heading", { name: block.heading }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: `Add ${block.singular}` }),
        ).toHaveAttribute(
          "href",
          `/${kind === "gear" ? "gear" : "supplies"}/new?section=${section.slug}`,
        );
        expect(screen.getByText(`No ${block.plural} yet`)).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Add magazine" })).toHaveAttribute(
      "href",
      "/accessories/new?section=magazines",
    );
    expect(screen.getByText("No magazines yet")).toBeInTheDocument();
  });
});
