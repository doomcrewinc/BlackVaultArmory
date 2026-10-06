// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AccessoriesClientPage } from "@/app/accessories/AccessoriesClientPage";
import { GearClientPage } from "@/app/gear/GearClientPage";
import { SupplyClientPage } from "@/app/supplies/SupplyClientPage";
import { sectionBySlug, type AddFormKind } from "@/lib/categories";
import {
  listWordingForSection,
  type ListWording,
} from "@/lib/sections/wording";

afterEach(cleanup);

type Screen = (wording: ListWording | undefined) => ReactElement;

const SCREENS: Record<AddFormKind, Screen> = {
  accessory: (wording) => (
    <AccessoriesClientPage
      accessories={[]}
      heading="Section"
      subheading="Things"
      wording={wording}
    />
  ),
  gear: (wording) => (
    <GearClientPage
      items={[]}
      timezoneConfigured
      heading="Section"
      subheading="Things"
      wording={wording}
    />
  ),
  supply: (wording) => (
    <SupplyClientPage
      items={[]}
      timezoneConfigured
      heading="Section"
      subheading="Things"
      wording={wording}
    />
  ),
};

const DEFAULTS: Record<
  AddFormKind,
  { add: string; empty: string; first: string; href: string }
> = {
  accessory: {
    add: "Add Accessory",
    empty: "No accessories yet",
    first: "Add First Accessory",
    href: "/accessories/new",
  },
  gear: {
    add: "Add Gear",
    empty: "No gear yet",
    first: "Add First Item",
    href: "/gear/new",
  },
  supply: {
    add: "Add Supply",
    empty: "No supplies yet",
    first: "Add First Supply",
    href: "/supplies/new",
  },
};

describe.each(Object.keys(SCREENS) as AddFormKind[])(
  "%s list screen without a section",
  (kind) => {
    it("keeps the generic wording and the plain add link", () => {
      render(SCREENS[kind](undefined));
      const expected = DEFAULTS[kind];
      expect(screen.getByRole("link", { name: expected.add })).toHaveAttribute(
        "href",
        expected.href,
      );
      expect(screen.getByText(expected.empty)).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: expected.first }),
      ).toHaveAttribute("href", expected.href);
    });
  },
);

describe.each([
  [
    "accessory",
    "magazines",
    "Add Magazine",
    "No magazines yet",
    "Add First Magazine",
  ],
  ["accessory", "optics", "Add Optic", "No optics yet", "Add First Optic"],
  [
    "accessory",
    "lowers",
    "Add Receiver",
    "No receivers yet",
    "Add First Receiver",
  ],
  ["accessory", "parts", "Add Part", "No parts yet", "Add First Part"],
  ["gear", "knives", "Add Knife", "No knives yet", "Add First Knife"],
  ["gear", "cases", "Add Case", "No cases yet", "Add First Case"],
  ["gear", "armor", "Add Armor", "No armor yet", "Add Armor"],
  ["gear", "shelter-clothing", "Add Item", "No items yet", "Add First Item"],
  [
    "supply",
    "cleaning",
    "Add Cleaning Supply",
    "No cleaning supplies yet",
    "Add First Cleaning Supply",
  ],
] as const)(
  "%s list screen on the %s section",
  (kind, slug, add, empty, first) => {
    const wording = listWordingForSection(sectionBySlug(slug)!, kind);

    it("names its things in the button and the empty state", () => {
      render(SCREENS[kind](wording));
      const href = `${DEFAULTS[kind].href}?section=${slug}`;
      const links = screen.getAllByRole("link", {
        name: (name) => name === add || name === first,
      });
      expect(links).toHaveLength(2);
      expect(links.map((link) => link.textContent).sort()).toEqual(
        [add, first].sort(),
      );
      for (const link of links) expect(link).toHaveAttribute("href", href);
      expect(screen.getByText(empty)).toBeInTheDocument();
      expect(
        screen.getByText(sectionBySlug(slug)!.emptyHint!),
      ).toBeInTheDocument();
    });

    it("shows none of the generic storage wording", () => {
      const { container } = render(SCREENS[kind](wording));
      expect(container.textContent).not.toMatch(
        /Add Accessory\b|Add Gear\b|Add Supply\b|No accessories yet|No gear yet|No supplies yet/,
      );
    });
  },
);

describe("accessory list screen statistics and filter", () => {
  const rows = ["MAGAZINE", "OPTIC"].map((type, i) => ({
    id: `a${i}`,
    name: `Item ${i}`,
    manufacturer: "",
    model: null,
    type,
    roundCount: 0,
    quantity: 1,
    imageUrl: null,
    purchasePrice: null,
    acquisitionDate: null,
    currentBuild: null,
  }));

  it("labels the total with the section's plural", () => {
    const wording = listWordingForSection(
      sectionBySlug("magazines")!,
      "accessory",
    );
    render(<AccessoriesClientPage accessories={rows} wording={wording} />);
    expect(screen.getByText("Total Magazines")).toBeInTheDocument();
    expect(screen.queryByText(/total parts/i)).toBeNull();
  });

  it("keeps the generic total label without a section", () => {
    render(<AccessoriesClientPage accessories={rows} />);
    expect(screen.getByText("Total Parts")).toBeInTheDocument();
  });
});
