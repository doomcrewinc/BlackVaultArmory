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
    add: "Add accessory",
    empty: "No accessories yet",
    first: "Add first accessory",
    href: "/accessories/new",
  },
  gear: {
    add: "Add gear",
    empty: "No gear yet",
    first: "Add first item",
    href: "/gear/new",
  },
  supply: {
    add: "Add supply",
    empty: "No supplies yet",
    first: "Add first supply",
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
  ["accessory", "magazines", "magazine", "magazines"],
  ["accessory", "optics", "optic", "optics"],
  ["accessory", "lowers", "receiver", "receivers"],
  ["accessory", "parts", "part", "parts"],
  ["gear", "knives", "knife", "knives"],
  ["gear", "cases", "case", "cases"],
  ["gear", "armor", "armor piece", "armor pieces"],
  ["supply", "cleaning", "cleaning supply", "cleaning supplies"],
] as const)("%s list screen on the %s section", (kind, slug, one, many) => {
  const wording = listWordingForSection(sectionBySlug(slug)!, kind);

  it("names its things in the button and the empty state", () => {
    render(SCREENS[kind](wording));
    const href = `${DEFAULTS[kind].href}?section=${slug}`;
    expect(screen.getByRole("link", { name: `Add ${one}` })).toHaveAttribute(
      "href",
      href,
    );
    expect(screen.getByText(`No ${many} yet`)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: `Add first ${one}` }),
    ).toHaveAttribute("href", href);
    expect(
      screen.getByText(sectionBySlug(slug)!.emptyHint),
    ).toBeInTheDocument();
  });

  it("shows none of the generic storage wording", () => {
    const { container } = render(SCREENS[kind](wording));
    expect(container.textContent).not.toMatch(
      /Add accessory\b|Add gear\b|Add supply\b|No accessories yet|No gear yet|No supplies yet|Add first item/i,
    );
  });
});

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
    expect(screen.getByText("Total magazines")).toBeInTheDocument();
    expect(screen.queryByText(/total parts/i)).toBeNull();
  });

  it("keeps the generic total label without a section", () => {
    render(<AccessoriesClientPage accessories={rows} />);
    expect(screen.getByText("Total parts")).toBeInTheDocument();
  });
});
